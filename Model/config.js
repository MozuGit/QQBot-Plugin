import makeConfig from '../../../lib/plugins/config.js'
import YAML from 'yaml'
import fs from 'node:fs'

let { config, configSave } = await makeConfig('QQBot', {
  tips: '',
  WsUrl: { 114514: 'ws://...' },
  ApiUrl: { 114514: 'http://...' },
  permission: 'master',
  dauDB: 'redis',
  toQRCode: false,
  toCallback: true,
  toBotUpload: true,
  forceSilk: false,
  hideGuildRecall: false,
  imageLength: 3,
  toQQUin: false,
  toImg: false,
  tencentCOS: {
    secretId: '',    // 腾讯云 API 密钥 SecretId
    secretKey: '',   // 腾讯云 API 密钥 SecretKey
    bucket: '',      // 存储桶名，如 mybucket-1250000000
    region: '',      // 存储桶地域，如 ap-guangzhou
    keyPrefix: '',   // 对象前缀（可选），如 QQBot
    endpoint: '',    // 自定义上传域名（可选），默认 https://{bucket}.cos.{region}.myqcloud.com
    bucketUrl: '',   // 自定义访问域名/CDN（可选），不填则用默认域名
    contentType: ''  // 强制上传 Content-Type（可选），默认按文件后缀推断
  },                 // 四项必填项留空时回退到官方演示桶（见 README）；填 false 可完全关闭图床
  callStats: false,
  userStats: false,
  markdown: {
    template: 'abcdefghij',
    prefix: '',
    suffix: '',
    affixMode: 'smart' // smart: 多行/图片/按钮/显式markdown注入；all: 所有raw markdown注入
  },
  keyboard: {},  // 按钮模板ID映射，格式如："3889001286": "102076896_1763887100"
  filter_bot_msg: false,
  sendButton: false,
  customMD: {},
  getAt: true,
  mdSuffix: {},
  btnSuffix: {},
  filterLog: {},
  simplifiedSdkLog: false,
  markdownImgScale: 1.0,
  sep: '',
  TextChains: false,
  stream: false,
  smallbtn: false,
  chunkSize: 2,
  delay: 100,
  bots: {},           // Per-bot 配置覆盖
  recall: { bots: {} },    // 召回系统配置
  claw: { bots: {} },      // Claw 配置交互
  inviteDB: 'level',       // 邀请/召回存储后端
  bot: {
    sandbox: false,
    maxRetry: Infinity,
    timeout: 30000
  },
  token: []
}, {
  tips: [
    '欢迎使用 TRSS-Yunzai QQBot Plugin ! 作者：时雨🌌星空 & 小叶 & 小丞 & TS霆生',
    '地址：https://gitee.com/ts-yf/QQBot-Plugin'
  ]
})

function refConfig() {
  config = YAML.parse(fs.readFileSync('config/QQBot.yaml', 'utf-8'))
}

export {
  config,
  configSave,
  refConfig
}
