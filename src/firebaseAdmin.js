// Initializes the Firebase Admin SDK once and exports it.
//
// On Cloud Run: no credentials file needed. The service runs as a Cloud Run
// service account, and admin.initializeApp() automatically uses Application
// Default Credentials to talk to Firebase Auth and Firestore.

import admin from "firebase-admin";

if (!admin.apps.length) {
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    "gen-lang-client-09340952-87717";

  admin.initializeApp({
    projectId,
  });
}

export default admin;
