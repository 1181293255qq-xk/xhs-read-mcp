// generate_sign.js - 生成小红书API签名
// 用法: node generate_sign.js <uri> <dataFile> <cookie>
const fs = require('fs');
const vm = require('vm');

// 读取签名JS
const signJs = fs.readFileSync('./signature.js', 'utf-8');

// 创建一个沙箱上下文
const context = {
  console: console,
  Buffer: Buffer,
  process: process,
  setTimeout: setTimeout,
  setInterval: setInterval,
  clearTimeout: clearTimeout,
  clearInterval: clearInterval,
  String: String,
  Array: Array,
  Object: Object,
  Number: Number,
  Boolean: Boolean,
  Math: Math,
  Date: Date,
  JSON: JSON,
  Error: Error,
  TypeError: TypeError,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  encodeURIComponent: encodeURIComponent,
  decodeURIComponent: decodeURIComponent,
  RegExp: RegExp,
  undefined: undefined,
};

// 在沙箱中执行签名JS
vm.createContext(context);
vm.runInContext(signJs, context);

// 读取参数
const [, , uri, dataFile, cookie] = process.argv;
const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));

// 调用签名函数
const result = context.GetXsXt(uri, data, cookie);
console.log(result);