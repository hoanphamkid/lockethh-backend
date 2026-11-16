const admin = require('firebase-admin');

// Expect FIREBASE_SERVICE_ACCOUNT JSON string in env
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccountJson) {
  console.warn('FIREBASE_SERVICE_ACCOUNT env var not set – using mock admin for development');
  // Mock admin with minimal verifyIdToken implementation
  const mockAdmin = {
    auth: () => ({
      verifyIdToken: async (token) => ({ uid: 'mock-uid' })
    })
  };
  module.exports = mockAdmin;
} else {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT JSON');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  module.exports = admin;
}
