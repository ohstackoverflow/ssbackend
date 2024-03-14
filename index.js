const express = require('express');
const app = express();
var bodyParser = require('body-parser')
// create application/x-www-form-urlencoded parser
var urlencodedParser = bodyParser.urlencoded({ extended: false })
app.use(urlencodedParser);  //*****重要：否则，无法获取到post请求的url参数。


var httprequest = require('request');
const https = require('https');


// create application/json parser
var jsonParser = bodyParser.json();

const cors = require('cors');
app.use(cors({
    origin: ['http://localhost:9517', 'https://ssvip.yesky.online', 'https://ss.yesky.online', 'https://xiaotusoushu.web.app']
}));


const multer = require("multer");
const upload = multer({ dest: "public/uploads/" });

var fs = require('fs');


const AlipaySdk = require('alipay-sdk').default;
// TypeScript，可以使用 import AlipaySdk from 'alipay-sdk';
// 普通公钥模式
const alipaySdk = new AlipaySdk({
    appId: '2021004105625781',
    privateKey: process.env.ALI_PRV_KEY,
    alipayPublicKey: process.env.ALI_PBL_KEY,
});

const mysql = require('mysql');
// var con = mysql.createPool({
//     host: "localhost",
//     user: "root",
//     password: process.env.DB_PWD,
//     database: "booksearch",
//     multipleStatements: true
// });
var con = mysql.createPool({
    host: "localhost",
    user: "booksearch-backend",
    password: process.env.DB_PWD,
    database: "booksearch_backend_db",
    multipleStatements: true
});

var jwt = require("jsonwebtoken");
const secret = "secret4book";

app.get("/", async function(request, response) {
    console.log("alive.");
    response.json("Live");
});

app.post('/uploadfile', upload.single("image"), function(request, response) {

    console.log(request.body);
    console.log(request.file);
    //var content = fs.readFileSync(request.file.destination + request.file.filename);
    //console.log(content);

    //response.json({ message: "Successfully uploaded files" });
    response.status(200).json({
        'imagename': request.file.filename
    });

})

function getClientIp(request) {
    return request.headers['x-forwarded-for'] || request.connection.remoteAddress;;
};

app.post("/userregister", jsonParser, function(req, res) {
    const username = req.body.username;
    con.query("select count(*) ct from users where username=?", [req.body.username], function (err, result, fields) {
        if (err) throw err;
        console.log(result);
        if(result[0].ct === 0) {
            const userip = getClientIp(req);
            const rtime = new Date();
            con.query("insert into users(username,password,rtime, ip) values(?,?,?,?);", [username, req.body.password, rtime, userip], function (err, result, fields) {
                if (err) throw err;
                //console.log(result);
            });

            //设置登录token
            let token = jwt.sign({ id: username }, secret);

            res.json({ret:1, user:{token: token, username: username, regtime:rtime}});
        } else {
            res.json({ret:0, msg:"该用户名已存在"});
        }
    });



});

app.post("/userlogin", jsonParser, function(req, res) {
    const username = req.body.username;
    con.query("select * from users where username=? and password=?", [req.body.username, req.body.password], function (err, result, fields) {
        if (err) throw err;
        console.log(result);
        if(result.length === 1) {
            //设置登录token
            let token = jwt.sign({ id: username }, secret);
            res.json({ret:1, user:{token: token, username: username, vipexpired:result[0]['vipexpired'], regtime: result[0]['rtime']}});
        } else {
            res.json({ret:0, msg:"用户名或密码有误"});
        }
    });
});


app.post("/userdownloadlog", jsonParser, function(req, res) {
    con.query("insert into userdownload(username, userip, bookname, ipfscid, sourcesite, state) values(?,?,?,?,?,?)", [req.body.username, getClientIp(req), req.body.bookname,req.body.ipfscid,req.body.site,req.body.state], function (err, result, fields) {
        if (err) throw err;
    });
    res.json({ret:1});
});


app.post('/mypayment', jsonParser, async function(request, response) {
    console.log("query payment");
    con.query("select * from payment where username=? and status='PAYED' and paytime > NOW()-INTERVAL 1 HOUR", [request.body.username], function (err, result, fields) {
        if (err) {
            console.log(err);
        };
        response.json(result);
    });

});

//生成预订单、生成二维码
app.post('/createpayment', jsonParser, async function(request, response) {

    Date.prototype.addDays = function(days) {
        var date = new Date(this.valueOf());
        date.setDate(date.getDate() + days);
        return date;
    }

    const now = new Date();
    const ts = now.getTime();
    let expired = now;
    switch (request.body.productype) {
        case 1:
            expired = now.addDays(31);
            break;
        case 2:
            expired = now.addDays(366);
            break;
    }

    con.query("insert into payment(username,amount,paytime,productype,expiredtime,orderId) values(?,?,?,?,?,?);", [request.body.username, request.body.amount, now, request.body.productype, expired, request.body.out_trade_no], function (err, result, fields) {
        if (err) {
            console.log(err);
        };
    });

    let qrCode = "";

    try {
        const result = await alipaySdk.exec('alipay.trade.precreate', {
            notify_url: process.env.CALLBACK_URL, // 通知回调地址
            bizContent: {
                out_trade_no: request.body.out_trade_no,
                total_amount: request.body.amount,
                subject: '小兔搜书'
            }
        });
        console.log(result);
        qrCode = result.qrCode;
    } catch(e) {
        console.log(e);
    }

    response.json(qrCode);

});



//轮询检查payment
app.post('/checkpayment', jsonParser, async function(request, response) {

    const outTradeNo = request.body.out_trade_no;

    const resultPay = await alipaySdk.exec('alipay.trade.query', {
        bizContent: {
            out_trade_no: outTradeNo,
        }
    });

    console.log(resultPay.tradeStatus);

    const flag= resultPay.tradeStatus === "TRADE_SUCCESS";

    if(flag) {

        con.query("update payment set status='PAYED' where orderId=?; update users u join (select username,expiredtime from payment where orderId=?) p on u.username = p.username set u.vipexpired = p.expiredtime;", [outTradeNo,outTradeNo], function (err, result, fields) {
            if (err) {
                console.log(err);
            };
        });

    }

    response.json(flag);

});

app.post('/paymentcallback', function(request, response) {
    //console.log(request);
    console.log("pcallback");
    console.log("-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-");
    console.log(request.body.out_trade_no);
    if(request.body.trade_status === "TRADE_SUCCESS") {
        const outTradeNo = request.body.out_trade_no;
        //request.body.gmt_payment,
        //console.log(request.body);

        con.query("update payment set status='PAYED' where orderId=?; update users u join (select username,expiredtime from payment where orderId=?) p on u.username = p.username set u.vipexpired = p.expiredtime;", [outTradeNo,outTradeNo], function (err, result, fields) {
            if (err) {
                console.log(err);
            };
        });

    }
    response.json({});
});



app.listen(process.env.PORT,() => console.log(('listening :)')))