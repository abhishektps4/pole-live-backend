const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 4000;

// In-memory store for single-room polls (simple implementation)
let currentPoll = null; // { id, question, options: [{id, text, votes}], startedAt, duration, active, submissions: Set }
let previousPolls = [];

function createPoll(payload) {
  const id = uuidv4();
  const options = payload.options.map((t, idx) => ({ id: idx.toString(), text: t, votes: 0 }));
  return {
    id,
    question: payload.question,
    options,
    startedAt: Date.now(),
    duration: payload.duration || 60,
    active: true,
    submissions: new Set()
  };
}

function computeResults(poll) {
  const total = poll.options.reduce((s, o) => s + o.votes, 0);
  return {
    id: poll.id,
    question: poll.question,
    options: poll.options.map(o => ({ id: o.id, text: o.text, votes: o.votes, pct: total === 0 ? 0 : Math.round((o.votes/total)*100) })),
    total
  };
}

let endTimer = null;
let teacherSocketId = null;

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // join a global room for simplicity
  socket.join('poll-room');

  socket.on('register-teacher', () => {
    teacherSocketId = socket.id;
  });

  socket.on('create-poll', (payload, cb) => {
    // Check if existing poll active and not all responded
    if (currentPoll && currentPoll.active) {
      return cb && cb({ success: false, message: 'A poll is already active.' });
    }
    currentPoll = createPoll(payload);
    // broadcast
    io.to('poll-room').emit('new-poll', computeResults(currentPoll));
    // setup end timer
    if (endTimer) {
      clearTimeout(endTimer);
      endTimer = null;
    }
    endTimer = setTimeout(() => {
      finishCurrentPoll('timeout');
    }, currentPoll.duration * 1000);
    cb && cb({ success: true, poll: computeResults(currentPoll) });
    console.log('Created poll', currentPoll.question);
  });

  socket.on('vote', ({ pollId, optionId, studentId, studentName }, cb) => {
    if (!currentPoll || !currentPoll.active || currentPoll.id !== pollId) {
      return cb && cb({ success: false, message: 'No active poll' });
    }
    // prevent multiple submissions per student
    if (currentPoll.submissions.has(studentId)) {
      return cb && cb({ success: false, message: 'Already voted' });
    }
    // find option
    const opt = currentPoll.options.find(o => o.id === optionId);
    if (!opt) {
      return cb && cb({ success: false, message: 'Invalid option' });
    }
    opt.votes += 1;
    currentPoll.submissions.add(studentId);
    // broadcast updated results
    io.to('poll-room').emit('poll-update', computeResults(currentPoll));
    // If all connected students have responded? (we can't know total students reliably); teacher may control flow.
    cb && cb({ success: true });
    console.log(`${studentName} voted option ${opt.text}`);
  });

  socket.on('end-poll-now', (cb) => {
    // teacher requested early end
    if (!currentPoll || !currentPoll.active) return cb && cb({ success: false, message: 'No active poll' });
    finishCurrentPoll('manual');
    cb && cb({ success: true });
  });

  socket.on('remove-student', ({ studentId }, cb) => {
    // teacher removes a student (bonus) - no persistent connections for students in this basic impl
    // notify teacher + students
    io.to('poll-room').emit('student-removed', { studentId });
    cb && cb({ success: true });
  });

  socket.on('get-current-poll', (cb) => {
    if (!currentPoll) return cb && cb({ poll: null });
    cb && cb({ poll: computeResults(currentPoll), active: currentPoll.active, remaining: remainingSeconds() });
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
    if (socket.id === teacherSocketId) teacherSocketId = null;
  });
});

function finishCurrentPoll(reason = 'timeout') {
  if (!currentPoll) return;
  currentPoll.active = false;
  // store previous poll
  previousPolls.unshift(computeResults(currentPoll));
  // trim
  if (previousPolls.length > 50) previousPolls.pop();
  io.to('poll-room').emit('poll-ended', { poll: computeResults(currentPoll), reason });
  currentPoll = null;
  if (endTimer) {
    clearTimeout(endTimer);
    endTimer = null;
  }
}

function remainingSeconds() {
  if (!currentPoll) return 0;
  const elapsed = (Date.now() - currentPoll.startedAt) / 1000;
  return Math.max(0, Math.ceil(currentPoll.duration - elapsed));
}

app.get('/', (req, res) => {
  res.send({ ok: true, message: 'Live poll backend running' });
});

app.get('/previous-polls', (req, res) => {
  res.send(previousPolls);
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
