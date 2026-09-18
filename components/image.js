import QRCode from 'qrcode'
import imageSize from 'image-size'
import fetch from 'node-fetch'
import { config, Handler } from '../Model/index.js'
import { URL_REGEXP_FULL, sharp } from '../utils/constants.js'
import { pickImageSizeOptions } from '../utils/helpers.js'
import { hasCustomCOS, putCOSObject, resolveCOSConfig } from '../utils/cos.js'
import { getBotConfigValue } from './config.js'
import { makeButtons } from './button.js'

async function makeQRCode(adapter, data) {
  return (await QRCode.toDataURL(data)).replace('data:image/png;base64,', 'base64://')
}

async function makeRawMarkdownText(adapter, data, text, button) {
  if (adapter.toQRCodeMode === 'url') {
    text = text.replace(URL_REGEXP_FULL, '<$&>')
  } else if (adapter.toQRCodeRegExp) {
    const match = text.match(adapter.toQRCodeRegExp)
    if (match) {
      for (const url of match) {
        button.push(...makeButtons(adapter, data, [[{ text: url, link: url }]]))
        const img = await makeMarkdownImage(adapter, data, await makeQRCode(adapter, url), '二维码')
        text = text.replace(url, `${img.des}${img.url}`)
      }
    }
  }
  return text.replace(/@\u200B/g, '@').replace(/<qqbot-\u200B/g, "<qqbot-")
}

async function makeBotImage(adapter, file) {
  if (config.toBotUpload) {
    for (const i of Bot.uin) {
      if (!Bot[i].uploadImage) continue
      try {
        const image = await Bot[i].uploadImage(file)
        if (image.url) return image
      } catch (err) {
        Bot.makeLog('error', ['Bot', i, '图片上传错误', file, err])
      }
    }
  }
}

function getCOSConfig(adapter, selfId = '') {
  return resolveCOSConfig(getBotConfigValue(adapter, selfId, 'tencentCOS'))
}

/**
 * 腾讯云 COS 图床
 * - config.tencentCOS 配好 secretId/secretKey/bucket/region 时，直传自己的存储桶（官方签名鉴权）
 * - 未配置时回退到官方演示桶上传凭证（无需配置，但可能随时失效）
 * - 置为 false 可完全关闭图床，走适配器上传 / 本地链接
 */
async function uploadToTencentCOS(adapter, buffer, file, selfId = '') {
  const cos = getCOSConfig(adapter, selfId)
  if (!cos && !getBotConfigValue(adapter, selfId, 'tencentCOS')) return null

  if (hasCustomCOS(cos)) {
    try {
      const { url, key } = await putCOSObject(cos, buffer, { file })
      Bot.makeLog('debug', ['腾讯 COS 上传成功', url], selfId)
      return { success: true, url, key }
    } catch (err) {
      Bot.makeLog('error', ['腾讯 COS 上传失败', err.message], selfId)
      return { success: false, error: err.message }
    }
  }

  try {
    const fetchImpl = typeof fetch !== 'undefined' ? fetch : await import('node-fetch').then(module => module.default);
    const getResponse = await fetchImpl(`https://ci-exhibition.cloud.tencent.com/samples/createUploadKey?ext=png&ciProcess=sensitive-content-recognition`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; 22041216C Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.179 Mobile Safari/537.36',
        'sec-ch-ua-platform': '"Android"',
        'origin': 'https://cloud.tencent.com',
        'x-requested-with': 'mark.via',
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cloud.tencent.com/act/pro/ciExhibition?from=15775&tab=contentReview&sub=pictureReview'
      }
    });
    if (!getResponse.ok) {
      throw new Error(`获取上传凭证失败: ${getResponse.status}`);
    }
    const uploadData = await getResponse.json();
    if (!uploadData?.data?.key || !uploadData?.data?.uploadAuthorization) {
      throw new Error('获取腾讯 COS 上传凭证失败：返回数据格式异常');
    }
    const uploadKey = uploadData.data.key;
    const uploadAuth = uploadData.data.uploadAuthorization;
    const uploadUrl = "https://ci-h5-demo-1258125638.cos.ap-chengdu.myqcloud.com/" + uploadKey;
    const putResponse = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': uploadAuth,
        'Content-Length': buffer.length.toString(),
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; 22041216C Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.179 Mobile Safari/537.36',
        'sec-ch-ua-platform': '"Android"',
        'origin': 'https://cloud.tencent.com',
        'x-requested-with': 'mark.via',
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cloud.tencent.com/act/pro/ciExhibition?from=15775&tab=contentReview&sub=pictureReview'
      },
      body: buffer
    });
    if (putResponse.status === 200) {
      const finalImageUrl = uploadUrl.startsWith('http')
        ? uploadUrl
        : 'https://' + uploadUrl;
      return { success: true, url: finalImageUrl };
    } else {
      Bot.makeLog('error', ['腾讯 COS 上传失败', putResponse.status], 'QQBot-Plugin');
      throw new Error(`COS 上传返回异常状态码: ${putResponse.status}`);
    }
  } catch (error) {
    Bot.makeLog('error', ['腾讯 COS 上传失败', error.message], 'QQBot-Plugin');
    return {
      success: false,
      error: error.message
    };
  }
}

async function makeMarkdownImage(adapter, data, file, summary = '图片', options = {}) {
  const buffer = await Bot.Buffer(file)
  const image =
    await uploadToTencentCOS(adapter, buffer, file, data.self_id) ||
    await makeBotImage(adapter, buffer) ||
    { url: await Bot.fileToUrl(file) }

  if (!image.width || !image.height) {
    try {
      const size = imageSize(buffer)
      image.width = size.width
      image.height = size.height
    } catch (err) {
      Bot.makeLog('error', ['图片分辨率检测错误', file, err], data.self_id)
    }
  }

  const imageSizeOptions = pickImageSizeOptions(options) || {}
  const scale = imageSizeOptions.scale || config.markdownImgScale

  if (imageSizeOptions.width && imageSizeOptions.height) {
    image.width = Math.floor(imageSizeOptions.width)
    image.height = Math.floor(imageSizeOptions.height)
  } else if (imageSizeOptions.width && image.width && image.height) {
    image.height = Math.floor(image.height * imageSizeOptions.width / image.width)
    image.width = Math.floor(imageSizeOptions.width)
  } else if (imageSizeOptions.height && image.width && image.height) {
    image.width = Math.floor(image.width * imageSizeOptions.height / image.height)
    image.height = Math.floor(imageSizeOptions.height)
  } else {
    image.width = Math.floor(image.width * scale)
    image.height = Math.floor(image.height * scale)
  }

  if (Handler.has('QQBot.makeMarkdownImage')) {
    const res = await Handler.call(
      'QQBot.makeMarkdownImage',
      data,
      {
        image,
        buffer,
        file,
        summary,
        config
      }
    )
    if (res) {
      typeof res == 'object' ? Object.assign(image, res) : image.url = res
    }
  }

  return {
    des: `![${summary} #${image.width || 0}px #${image.height || 0}px]`,
    url: `(${image.url})`
  }
}

async function compressImage(adapter, data, file) {
  try {
    const size = config.imageLength * 1024 * 1024
    const buffer = await Bot.Buffer(file, { http: true })

    if (!Buffer.isBuffer(buffer))
      return file

    if (buffer.length <= size)
      return buffer

    let quality = 105, output
    do {
      quality -= 10
      output = await sharp(buffer).jpeg({ quality }).toBuffer()
      Bot.makeLog("debug", `图片压缩完成 ${quality}%(${(output.length / 1024).toFixed(2)}KB)`, data.self_id)
    } while (output.length > size && quality > 10)

    return output
  } catch (err) {
    Bot.makeLog("error", ["图片压缩错误", err], data.self_id)
    return file
  }
}

export function installImage(adapter) {
  adapter.makeQRCode = (data) => makeQRCode(adapter, data)
  adapter.makeRawMarkdownText = (data, text, button) => makeRawMarkdownText(adapter, data, text, button)
  adapter.makeBotImage = (file) => makeBotImage(adapter, file)
  adapter.getCOSConfig = (selfId) => getCOSConfig(adapter, selfId)
  adapter.hasCustomCOS = (selfId) => hasCustomCOS(getCOSConfig(adapter, selfId))
  adapter.uploadToTencentCOS = (buffer, file, selfId) => uploadToTencentCOS(adapter, buffer, file, selfId)
  adapter.makeMarkdownImage = (data, file, summary, options) => makeMarkdownImage(adapter, data, file, summary, options)
  adapter.compressImage = (data, file) => compressImage(adapter, data, file)
}

export {
  makeQRCode,
  makeRawMarkdownText,
  makeBotImage,
  getCOSConfig,
  hasCustomCOS,
  uploadToTencentCOS,
  makeMarkdownImage,
  compressImage
}
