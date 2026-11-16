const express = require('express')

const router = express.Router()

function getPublicOrigin(req) {
  const configured = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '')
  if (configured) return configured

  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim()
  const protocol = forwardedProto || req.protocol
  return `${protocol}://${req.get('host')}`
}

function buildShadowrocketConfig(req) {
  const origin = getPublicOrigin(req)
  const configUrl = `${origin}/locket.conf`

  // This is intentionally a routing-only config. It contains no Locket
  // credentials, App Check tokens, premium-unlock scripts, or MITM rules.
  return `#!name=Locket Studio
#!desc=Kết nối Locket Studio với các máy chủ Locket chính thức
#!author=Locket Studio
#!homepage=${origin}
#!configUrl=${configUrl}
#!howtouse=Shadowrocket
# Locket Studio — cấu hình định tuyến an toàn

[General]
bypass-system = true
skip-proxy = localhost, *.local, *.lan
dns-server = system

[Rule]
DOMAIN-SUFFIX,locket.camera,DIRECT
DOMAIN-SUFFIX,api.locketcamera.com,DIRECT
DOMAIN-SUFFIX,firebasestorage.googleapis.com,DIRECT
DOMAIN-SUFFIX,googleapis.com,DIRECT
DOMAIN-SUFFIX,firebaseio.com,DIRECT
FINAL,DIRECT
`
}

function sendConfig(req, res) {
  res
    .status(200)
    .type('text/plain; charset=utf-8')
    .set('Content-Disposition', 'inline; filename="locket-studio.conf"')
    .set('Cache-Control', 'public, max-age=300, must-revalidate')
    .send(buildShadowrocketConfig(req))
}

router.get('/locket.conf', sendConfig)

module.exports = router
