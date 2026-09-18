import { createHash, createHmac, randomUUID } from 'node:crypto'

const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  png: 'image/png'
}

export const COS_REQUIRED_FIELDS = ['secretId', 'secretKey', 'bucket', 'region']

/** 对象前缀只允许 URL 安全字符：签名按编码后的路径计算，含特殊字符时各 SDK 实现不一致 */
export const KEY_PREFIX_REGEXP = /^[A-Za-z0-9._/-]*$/

export const COS_FIELD_LABELS = {
  secretId: 'SecretId',
  secretKey: 'SecretKey',
  bucket: '存储桶',
  region: '地域',
  keyPrefix: '对象前缀',
  endpoint: '上传域名',
  bucketUrl: '访问域名',
  contentType: 'Content-Type'
}

function str(value) {
  return String(value ?? '').trim()
}

/**
 * 归一化图床配置。传入非对象（true/false/undefined）时返回 false。
 */
export function resolveCOSConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  return {
    secretId: str(raw.secretId),
    secretKey: str(raw.secretKey),
    bucket: str(raw.bucket),
    region: str(raw.region),
    keyPrefix: str(raw.keyPrefix).replace(/^\/+|\/+$/g, ''),
    endpoint: str(raw.endpoint).replace(/\/+$/, ''),
    bucketUrl: str(raw.bucketUrl).replace(/\/+$/, ''),
    contentType: str(raw.contentType)
  }
}

/** 四项必填齐全才算配置好自建图床 */
export function hasCustomCOS(cos) {
  return !!cos && COS_REQUIRED_FIELDS.every(field => !!cos[field])
}

export function validateCOSConfig(raw) {
  const cos = resolveCOSConfig(raw) || {}
  const missing = COS_REQUIRED_FIELDS.filter(field => !cos[field])
  if (missing.length) {
    return { ok: false, error: `缺少必填项：${missing.map(field => COS_FIELD_LABELS[field]).join('、')}` }
  }
  if (!KEY_PREFIX_REGEXP.test(cos.keyPrefix)) {
    return { ok: false, error: '对象前缀只能包含字母、数字、. _ - /' }
  }
  return { ok: true, cos }
}

export function getCOSDomain(cos) {
  return cos.endpoint || `https://${cos.bucket}.cos.${cos.region}.myqcloud.com`
}

export function getCOSPublicBase(cos) {
  return cos.bucketUrl || getCOSDomain(cos)
}

export function getCOSObjectKey(cos, file) {
  let name = ''
  try {
    name = decodeURIComponent(String(file ?? '').split('?')[0].split('/').pop() || '')
  } catch {
    name = ''
  }
  // 只接受已知图片后缀，避免对象键里混入需要百分号编码的字符
  const matched = name.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase()
  const ext = matched && CONTENT_TYPES[matched] ? matched : 'png'
  // 时间戳 + UUID 保证 object key 唯一，避免同名覆盖与 CDN 串图
  const key = `${cos.keyPrefix ? `${cos.keyPrefix}/` : ''}${Date.now()}-${randomUUID()}.${ext}`
  return { key, path: encodeObjectPath(key), ext }
}

/** 逐段编码，保留 / 作为路径分隔符 */
export function encodeObjectPath(key) {
  return String(key).split('/').map(camSafeUrlEncode).join('/')
}

function hmacSha1(key, data) {
  return createHmac('sha1', key).update(data, 'utf8').digest('hex')
}

function sha1(data) {
  return createHash('sha1').update(data, 'utf8').digest('hex')
}

/** 与官方 SDK 的 camSafeUrlEncode 一致：额外转义 ! ' ( ) * ，签名必须与之逐字节相同 */
export function camSafeUrlEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

/**
 * 腾讯云 COS 请求签名
 * @see https://cloud.tencent.com/document/product/436/7778
 */
export function buildCOSAuthorization({ secretId, secretKey, method, pathname, headers, start, end }) {
  const keyTime = `${start};${end}`
  const signKey = hmacSha1(secretKey, keyTime)
  // 逐项小写化并排序；取值必须用小写后的 key，否则混合大小写的 header 会取到 undefined
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  const headerList = Object.keys(lowerHeaders).sort()
  const httpHeaders = headerList
    .map(key => `${camSafeUrlEncode(key)}=${camSafeUrlEncode(str(lowerHeaders[key]))}`)
    .join('&')
  // 直传不带 ? 后参数，故 UrlParamList 与 HttpParameters 均为空
  const httpString = [method.toLowerCase(), pathname, '', httpHeaders, ''].join('\n')
  const stringToSign = ['sha1', keyTime, sha1(httpString), ''].join('\n')
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList.join(';')}`,
    'q-url-param-list=',
    `q-signature=${hmacSha1(signKey, stringToSign)}`
  ].join('&')
}

async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch
  return (await import('node-fetch')).default
}

/**
 * 使用自己的存储桶直传对象（PUT + 签名鉴权）
 * @returns {Promise<{url: string, key: string}>}
 */
export async function putCOSObject(cos, buffer, { file = '', key, contentType } = {}) {
  const target = key ? { key, path: encodeObjectPath(key), ext: (key.match(/\.([A-Za-z0-9]+)$/)?.[1] || 'png').toLowerCase() } : getCOSObjectKey(cos, file)
  const url = `${getCOSDomain(cos)}/${target.path}`
  const { host } = new URL(url)
  const length = Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(String(buffer))

  const headers = {
    Host: host,
    'Content-Type': contentType || cos.contentType || CONTENT_TYPES[target.ext] || 'image/png',
    'Content-Length': String(length)
  }
  const start = Math.floor(Date.now() / 1000) - 60
  const Authorization = buildCOSAuthorization({
    secretId: cos.secretId,
    secretKey: cos.secretKey,
    method: 'PUT',
    pathname: `/${target.path}`,
    headers,
    start,
    end: start + 1800
  })

  const fetchImpl = await getFetch()
  const res = await fetchImpl(url, { method: 'PUT', headers: { ...headers, Authorization }, body: buffer })
  if (!(res.ok || res.status === 200 || res.status === 204)) {
    const detail = await res.text().catch(() => '')
    throw new Error(`COS PUT ${res.status} ${detail.slice(0, 200)}`.trim())
  }
  return { url: `${getCOSPublicBase(cos)}/${target.path}`, key: target.key }
}

/** 最小 PNG，用于配置连通性测试 */
export const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

export async function testCOSConfig(cos) {
  const { url, key } = await putCOSObject(cos, TEST_PNG, { key: `${cos.keyPrefix ? `${cos.keyPrefix}/` : ''}qqbot-test-${Date.now()}.png` })
  return { url, key }
}
