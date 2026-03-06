importScripts('https://www.gstatic.com/firebasejs/10.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyCFntZkmW9c4YE7u5RmPyhnE2QZecBYKZQ",
  authDomain:        "agroscan-ipe.firebaseapp.com",
  projectId:         "agroscan-ipe",
  storageBucket:     "agroscan-ipe.firebasestorage.app",
  messagingSenderId: "872758401279",
  appId:             "1:872758401279:web:cc6db945851c665d9b14ca"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  self.registration.showNotification(payload.notification.title, {
    body:  payload.notification.body,
    icon:  '/vite.svg',
    data:  payload.data
  });
});