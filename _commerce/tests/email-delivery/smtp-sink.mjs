// A throwaway SMTP sink for the email-channel tests.
//
// It speaks the part of RFC 5321 the client uses, in both shapes a submission
// relay can take: implicit TLS on 465 and STARTTLS on 587. Both are covered
// because they fail differently - an implicit-TLS relay never sees a plaintext
// byte, while a STARTTLS relay must upgrade before the client will risk a
// credential, and a client that got the ordering wrong would leak one.
//
// The sink can also refuse authentication or the recipient, because "the relay
// said no" is the outcome an operator most needs to distinguish from "no mail was
// ever sent".

import { createServer as createTlsServer, createSecureContext, TLSSocket } from 'node:tls';
import { createServer as createNetServer } from 'node:net';

const GREETING = '220 sink.test ESMTP ready\r\n';

function ehloReply({ starttls }) {
  const lines = ['250-sink.test', '250-AUTH LOGIN'];
  if (starttls) lines.push('250-STARTTLS');
  lines.push('250 8BITMIME');
  return `${lines.join('\r\n')}\r\n`;
}

export async function startSmtpSink({
  key, cert, mode = 'implicit',
  user = 'owner@example.test', password = 'app-password-1234',
  rejectRecipient = false, requireAuth = false,
} = {}) {
  const secureContext = createSecureContext({ key, cert });
  const messages = [];
  const sockets = new Set();

  const onConnection = (initialSocket) => {
    let socket = initialSocket;
    let buffer = '';
    let stage = 'command';
    let pending = '';
    let authUser = null;
    let authenticated = false;
    let from = '';
    let to = '';
    let upgraded = mode === 'implicit';

    const write = (text) => socket.write(text);
    sockets.add(initialSocket);
    initialSocket.on('close', () => sockets.delete(initialSocket));
    socket.on('error', () => {});

    const finishData = (body) => {
      messages.push({
        from,
        to,
        // The transfer doubled any leading dot; the receiver restores it.
        body: body.replace(/\r\n\.\./g, '\r\n.').replace(/^\.\./, '.'),
        authenticated,
      });
      to = '';
      write('250 2.0.0 Ok: queued as SINK1\r\n');
    };

    const handleAuth = (line) => {
      if (authUser === null) {
        authUser = Buffer.from(line, 'base64').toString('utf8');
        write('334 UGFzc3dvcmQ6\r\n');
        return;
      }
      const suppliedPassword = Buffer.from(line, 'base64').toString('utf8');
      const correct = authUser === user && suppliedPassword === password;
      authUser = null;
      pending = '';
      authenticated = correct;
      write(correct ? '235 2.7.0 Authentication successful\r\n' : '535 5.7.8 Authentication credentials invalid\r\n');
    };

    const handleCommand = (line) => {
      const verb = line.split(' ')[0].toUpperCase();
      const argument = line.slice(verb.length + 1);
      switch (verb) {
        case 'EHLO':
        case 'HELO':
          write(ehloReply({ starttls: mode === 'starttls' && !upgraded }));
          return;
        case 'STARTTLS': {
          if (mode !== 'starttls' || upgraded) { write('503 5.5.1 Already secured\r\n'); return; }
          write('220 2.0.0 Ready to start TLS\r\n');
          buffer = '';
          const secured = new TLSSocket(initialSocket, { isServer: true, secureContext });
          secured.on('error', () => {});
          secured.on('secure', () => {
            upgraded = true;
            socket = secured;
            secured.on('data', onData);
          });
          return;
        }
        case 'AUTH':
          if (authenticated) { write('503 5.5.1 Already authenticated\r\n'); return; }
          pending = 'auth';
          write('334 VXNlcm5hbWU6\r\n');
          return;
        case 'MAIL':
          if (requireAuth && !authenticated) { write('530 5.7.0 Authentication required\r\n'); return; }
          from = argument.replace(/^FROM:</i, '').replace(/>$/, '');
          write('250 2.1.0 Ok\r\n');
          return;
        case 'RCPT':
          if (rejectRecipient) { write('550 5.1.1 No such user here\r\n'); return; }
          to = argument.replace(/^TO:</i, '').replace(/>$/, '');
          write('250 2.1.5 Ok\r\n');
          return;
        case 'DATA':
          if (!to) { write('503 5.5.1 Need RCPT first\r\n'); return; }
          stage = 'data';
          buffer = '';
          write('354 End data with <CR><LF>.<CR><LF>\r\n');
          return;
        case 'QUIT':
          write('221 2.0.0 Bye\r\n');
          socket.end();
          return;
        default:
          write(`502 5.5.2 Command not implemented: ${verb}\r\n`);
      }
    };

    // A message body is raw until the terminating dot line. The dot may also be
    // the very first thing in the buffer, which has no preceding CRLF to find.
    const drainData = () => {
      if (buffer.startsWith('.\r\n')) {
        buffer = buffer.slice(3);
        finishData('');
        stage = 'command';
        return true;
      }
      const terminator = buffer.indexOf('\r\n.\r\n');
      if (terminator < 0) return false;
      const body = buffer.slice(0, terminator);
      buffer = buffer.slice(terminator + 5);
      finishData(body);
      stage = 'command';
      return true;
    };

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (stage === 'data') {
          if (!drainData()) return;
          continue;
        }
        const breakAt = buffer.indexOf('\r\n');
        if (breakAt < 0) return;
        const line = buffer.slice(0, breakAt);
        buffer = buffer.slice(breakAt + 2);
        if (pending === 'auth') handleAuth(line);
        else handleCommand(line);
      }
    }

    write(GREETING);
    socket.on('data', onData);
  };

  const server = mode === 'implicit'
    ? createTlsServer({ key, cert }, onConnection)
    : createNetServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    messages,
    // A client that finished by writing QUIT leaves a half-closed socket behind;
    // closing the listener alone would wait on it, so the sink ends its own side.
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
