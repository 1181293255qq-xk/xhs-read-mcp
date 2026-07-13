// generate_sign.js - 生成小红书API签名
// 用法: node generate_sign.js <uri> <dataFile> <cookie>
const fs = require('fs');

// 读取签名JS
const signJs = fs.readFileSync('./signature.js', 'utf-8');
// 执行签名JS（定义 GetXsXt 函数）
eval(signJs);

// 读取参数
const [, , uri, dataFile, cookie] = process.argv;
const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));

// 生成签名
const result = GetXsXt(uri, data, cookie);
console.log(result);