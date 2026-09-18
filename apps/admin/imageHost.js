import { config, configSave } from '../../Model/index.js'
import { getCOSDomain, getCOSPublicBase, resolveCOSConfig, testCOSConfig, validateCOSConfig } from '../../utils/cos.js'

const MASK_CHAR = '****'
const KEEP = '-'
const FORMAT = [
  '#QQBot图床设置SecretId:SecretKey:存储桶:地域:前缀',
  '示例：#QQBot图床设置AKIDxxxx:xxxxxxxx:mybucket-1250000000:ap-guangzhou:QQBot',
  `• 存储桶、地域必填；前缀可留空，用 ${KEEP} 表示清空`,
  `• SecretKey 处填 ${MASK_CHAR} 表示不修改已保存的密钥`,
  '• 上传域名/访问域名/CDN 请直接编辑 config/QQBot.yaml'
].join('\n')

/** 密钥脱敏展示，保留前 4 位便于核对 */
export function maskSecret(value) {
  const text = String(value ?? '')
  if (!text) return ''
  if (text.length <= 4) return MASK_CHAR
  return `${text.slice(0, 4)}${MASK_CHAR}`
}

/** 判断用户回传的是脱敏值而非真实密钥 */
export function isMasked(value, stored) {
  const text = String(value ?? '').trim()
  return !!stored && (text === maskSecret(stored) || (text.includes(MASK_CHAR) && text.startsWith(String(stored).slice(0, 4))))
}

function describeCOS(cos) {
  if (!cos) return '未配置（使用官方演示桶）'
  const missing = validateCOSConfig(cos)
  return [
    `SecretId: ${maskSecret(cos.secretId) || '（未填）'}`,
    `SecretKey: ${maskSecret(cos.secretKey) || '（未填）'}`,
    `存储桶: ${cos.bucket || '（未填）'}`,
    `地域: ${cos.region || '（未填）'}`,
    `对象前缀: ${cos.keyPrefix || '（无）'}`,
    `上传域名: ${cos.endpoint || getCOSDomain(cos) + '（默认）'}`,
    `访问域名: ${cos.bucketUrl || getCOSPublicBase(cos) + '（默认）'}`,
    `状态: ${missing.ok ? '✅ 自建图床已生效' : `⚠️ ${missing.error}，当前回退官方演示桶`}`
  ].join('\n')
}

export async function ImageHost() {
  const stored = resolveCOSConfig(config.tencentCOS)
  if (config.tencentCOS === false) {
    this.reply('图床已关闭（tencentCOS: false）\n上传将回退到适配器上传 / 本地链接', true)
    return false
  }
  this.reply(['当前腾讯云 COS 图床配置', describeCOS(stored), '', FORMAT].join('\n'), true)
  return false
}

export async function ImageHostSet() {
  const raw = this.e.msg.replace(/^#[Qq]+[Bb]ot图床设置/i, '').trim()
  const [secretId, secretKey, bucket, region, keyPrefix] = raw.split(':')
  if ([secretId, secretKey, bucket, region].some(value => typeof value === 'undefined')) {
    this.reply(`配置格式错误\n${FORMAT}`, true)
    return false
  }

  const stored = resolveCOSConfig(config.tencentCOS) || {}
  // 已保存密钥回填，避免脱敏值覆盖真实 SecretKey
  const nextSecretKey = isMasked(secretKey, stored.secretKey) ? stored.secretKey : secretKey.trim()

  const candidate = {
    ...stored,
    secretId: secretId.trim() || stored.secretId,
    secretKey: nextSecretKey,
    bucket: bucket.trim() || stored.bucket,
    region: region.trim() || stored.region,
    keyPrefix: keyPrefix === KEEP ? '' : (keyPrefix?.trim() ?? stored.keyPrefix ?? '')
  }

  const { ok, error, cos } = validateCOSConfig(candidate)
  if (!ok) {
    this.reply(`${error}\n${FORMAT}`, true)
    return false
  }

  let test
  try {
    test = await testCOSConfig(cos)
  } catch (err) {
    logger.error(`[QQBot] 图床连通性测试失败: ${err.message}`)
    this.reply(`配置未保存，上传测试失败：${err.message}\n请检查 SecretId/SecretKey、存储桶名、地域是否正确，以及密钥是否有该桶的写入权限`, true)
    return false
  }

  config.tencentCOS = { ...cos }
  await configSave()

  logger.info(`[QQBot] 自定义图床配置成功，测试文件: ${test.url}`)
  this.reply([
    '图床配置成功并已保存 ✅',
    `上传域名: ${getCOSDomain(cos)}`,
    `测试图片: ${test.url}`,
    '若测试图片打不开，请把访问域名改成该桶的 CDN/自定义域名',
    '',
    '提示：确认无误后可在 COS 控制台删除测试文件，也可用同一命令覆盖修改任何字段'
  ].join('\n'), true)
  return false
}
