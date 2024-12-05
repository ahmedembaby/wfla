const { Client, Chat, GroupChat, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');
const axios = require('axios');
const port = process.env.PORT || 8000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));



/**
 * BASED ON MANY QUESTIONS
 * Actually ready mentioned on the tutorials
 * 
 * The two middlewares above only handle for data json & urlencode (x-www-form-urlencoded)
 * So, we need to add extra middleware to handle form-data
 * Here we can use express-fileupload
 */
app.use(fileUpload({
  debug: false
}));

app.get('/', (req, res) => {
  res.sendFile('index.html', {
    root: __dirname
  });
});

const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch(err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = function(sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function(err) {
    if (err) {
      console.log(err);
    }
  });
}

const getSessionsFile = function() {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}

const createSession = function(id, description) {
  console.log('Creating session: ' + id);
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- this one doesn't works in Windows
        '--disable-gpu'
      ],
    },
    authStrategy: new LocalAuth({
      clientId: id
    })
  });

  client.initialize();

  client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.toDataURL(qr, (err, url) => {
      io.emit('qr', { id: id, src: url });
      io.emit('message', { id: id, text: 'QR Code received, scan please!' });
    });
  });

  client.on('ready', () => {
    io.emit('ready', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is ready!' });

    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions[sessionIndex].ready = true;
    setSessionsFile(savedSessions);
  });

  client.on('authenticated', () => {
    io.emit('authenticated', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is authenticated!' });
  });

  client.on('auth_failure', function() {
    io.emit('message', { id: id, text: 'Auth failure, restarting...' });
  });

  client.on('disconnected', (reason) => {
    io.emit('message', { id: id, text: 'Whatsapp is disconnected!' });
    client.destroy();
    client.initialize();

    // Menghapus pada file sessions
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions.splice(sessionIndex, 1);
    setSessionsFile(savedSessions);

    io.emit('remove-session', id);
  });

  // Tambahkan client ke sessions
  sessions.push({
    id: id,
    description: description,
    client: client
  });

  // Menambahkan session ke file
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      description: description,
      ready: false,
    });
    setSessionsFile(savedSessions);
  }
}

const init = function(socket) {
  const savedSessions = getSessionsFile();

  if (savedSessions.length > 0) {
    if (socket) {
      /**
       * At the first time of running (e.g. restarting the server), our client is not ready yet!
       * It will need several time to authenticating.
       * 
       * So to make people not confused for the 'ready' status
       * We need to make it as FALSE for this condition
       */
      savedSessions.forEach((e, i, arr) => {
        arr[i].ready = false;
      });

      socket.emit('init', savedSessions);
    } else {
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.description);
      });
    }
  }
}

init();

// Socket IO
io.on('connection', function(socket) {
  console.log('1 connected via WebSocket.');
  init(socket);

  socket.on('create-session', function(data) {
    console.log('Create session: ' + data.id);
    createSession(data.id, data.description);
  });
});

// Send message
app.post('/send-message', async (req, res) => {
  console.log(req);

  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;

  const client = sessions.find(sess => sess.id == sender).client;

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }

  /**
   * Check if the number is already registered
   * Copied from app.js
   * 
   * Please check app.js for more validations example
   * You can add the same here!
   */
  const isRegisteredNumber = await client.isRegisteredUser(number);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: 'The number is not registered'
    });
  }

  client.sendMessage(number, message).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

// Filter Numbers
app.post('/chknumber', async (req, res) => {
  console.log(req);

  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);

  const client = sessions.find(sess => sess.id == sender).client;

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }


  const isRegisteredNumber = await client.isRegisteredUser(number);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: 'The number is not registered'
    });
  } else{
          return res.status(200).json({
      status: true,
      message: 'The number is Found'
    });
  }

});
// get
app.get('/get', (req, res) => {
  const id = req.query.id; // تأخذ معرف الجلسة (id) من الطلب
  const session = sessions.find(sess => sess.id === id);

  if (!session) {
    return res.status(404).json({
      status: false,
      message: 'Session not found!'
    });
  }

  // إعادة تهيئة الجلسة لتوليد QR جديد
  session.client.destroy().then(() => {
    session.client.initialize();

    res.status(200).json({
      status: true,
      message: 'QR code will be generated. Please scan it again.',
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      message: 'Failed to regenerate QR code!',
      error: err,
    });
  });
});

//get my contacts
app.post('/mycont', async (req, res) => {
     console.log(req);
     const sender = req.body.sender;
       const client = sessions.find(sess => sess.id == sender).client;
         // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }
 const mychats = await client.getContacts();
 res.send(mychats)
});

//get my groups
app.post('/mygr', async (req, res) => {
     console.log(req);
     const sender = req.body.sender;
       const client = sessions.find(sess => sess.id == sender).client;
         // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }
 const mychats = await client.getChats();
 res.send(mychats)

});

//get group members
app.post('/grme', async (req, res) => {
          console.log(req);
     const sender = req.body.sender;
const hash = req.body.hash;
       const client = sessions.find(sess => sess.id == sender).client;
         // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }
 const mychats = await client.getChatById(hash);
 res.send(mychats)

});

//get last message
app.post('/lame', async (req, res) => {
     console.log(req);
     const sender = req.body.sender;
       const client = sessions.find(sess => sess.id == sender).client;
         // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }
 const mychats = await client.getChats();
  const lastmsg = await mychats.lastmsg();
 res.send(lastmsg)

});


//عمل session
app.get('/add-session/:id/:description', (req, res) => {
  const id = req.params.id; // معرّف الجلسة
  const description = req.params.description; // وصف الجلسة

  // تحقق إذا كانت الجلسة موجودة مسبقًا
  const existingSession = sessions.find(sess => sess.id === id);
  if (existingSession) {
    return res.status(400).send(`
      <h1>Session Already Exists</h1>
      <p>Session with ID: ${id} already exists.</p>
    `);
  }

  // إنشاء الجلسة الجديدة
  const newSession = { id, description, ready: false };
  sessions.push(newSession);

  // تحديث ملف الجلسات
  const savedSessions = getSessionsFile();
 savedSessions.push(newSession);
 setSessionsFile(savedSessions);


  // إرسال البيانات عبر WebSocket إلى العملاء
  io.emit('message', { id: id, text: 'New session added' });

  // استجابة للمستخدم
  res.send(`
    <h1>Session Created</h1>
    <p>Session with ID: ${id} and description: "${description}" has been created and saved.</p>
  `);
});


//اظهار qr

app.get('/qrcode/:id', (req, res) => {
  const id = req.params.id; // الحصول على معرف الجلسة من الرابط
  const session = sessions.find(sess => sess.id === id);

  if (!session) {
    return res.status(404).send(`
      <h1>Session Not Found</h1>
      <p>Unable to find session for ID: ${id}</p>
    `);
  }

  // صفحة تعرض QR Code باستخدام WebSocket
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>QR Code for ID: ${id}</title>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.3.0/socket.io.js"></script>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          margin-top: 50px;
        }
        img {
          margin-top: 20px;
          border: 2px solid #ccc;
          padding: 10px;
          border-radius: 5px;
        }
      </style>
    </head>
    <body>
      <h1>QR Code for ID: ${id}</h1>
      <div id="qr-container">
        <p>Waiting for QR Code...</p>
      </div>
      <script>
        const socket = io();

        socket.emit('get-qr', { id: '${id}' });

        socket.on('qr-code', function(data) {
          if (data.id === '${id}') {
            const qrContainer = document.getElementById('qr-container');
            qrContainer.innerHTML = '<img src="' + data.qr + '" alt="QR Code">';
          }
        });

        socket.on('qr-error', function(error) {
          const qrContainer = document.getElementById('qr-container');
          qrContainer.innerHTML = '<p style="color:red;">' + error.message + '</p>';
        });
      </script>
    </body>
    </html>
  `);
});

io.on('connection', (socket) => {
  console.log('2 connected via WebSocket.');

  socket.on('get-qr', (data) => {
    const { id } = data;
    const session = sessions.find(sess => sess.id === id);

    if (!session) {
      socket.emit('qr-error', { message: 'Session not found!' });
      return;
    }

    session.client.on('qr', (qr) => {
      console.log(`QR Code generated for session ${id}`);
      qrcode.toDataURL(qr, (err, url) => {
        if (err) {
          socket.emit('qr-error', { message: 'Error generating QR Code' });
          return;
        }
        socket.emit('qr-code', { id, qr: url });
      });
    });
  });
});



server.listen(port, function() {
  console.log('App running on *: ' + port);
});
