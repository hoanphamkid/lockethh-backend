const { randomBytes } = require('node:crypto');

// Request metadata adapted from locketlam 1.0.2. See THIRD_PARTY_NOTICES.md.
// These describe the client; they do not provide App Check attestation.
function createDevice() {
  return {
    installationId: randomBytes(11).toString('hex'),
    userAgent: 'com.locket.Locket/2.68.0 iPhone/17.4.1 hw/iPhone14_2',
  };
}

function getDevice(session) {
  session.device ||= createDevice();
  return session.device;
}

function headers(device) {
  const appCheckToken = process.env.LOCKET_APPCHECK_TOKEN?.trim();
  return {
    'User-Agent': device.userAgent,
    'X-Ios-Bundle-Identifier': 'com.locket.Locket',
    Accept: '*/*',
    ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}),
  };
}

function analytics(device) {
  const int64 = (value) => ({ '@type': 'type.googleapis.com/google.protobuf.Int64Value', value });
  return {
    ios_version: '2.68.0.2523',
    experiments: { flag_18: int64('1203'), flag_7: int64('800'), flag_10: int64('505') },
    installation_id: device.installationId,
    platform: 'ios',
  };
}

module.exports = { createDevice, getDevice, headers, analytics };
