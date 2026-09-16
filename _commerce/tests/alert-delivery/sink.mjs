// Throwaway HTTPS receiver used by tests/alert-delivery/run.sh.
//
// It answers exactly like the real chat platforms do, including the trap that
// matters most: Feishu and Telegram report application errors inside an HTTP 200
// body, so a monitor that only checks the status code would call a rejected alert
// "delivered".
import { createServer } from 'node:https';
import { appendFileSync, readFileSync } from 'node:fs';

const workDirectory = process.env.PAWSHOP_ALERT_TEST_DIR || '.';
const cert = readFileSync(`${workDirectory}/sink.crt`);
const key = readFileSync(`${workDirectory}/sink.key`);
const logFile = `${workDirectory}/requests.log`;
const port = Number(process.env.PAWSHOP_ALERT_TEST_PORT || 9443);

// Path selects the behaviour so every verdict can be exercised.
const responses = {
  '/feishu-ok': [200, '{"code":0,"msg":"success"}'],
  '/feishu-ok-v1': [200, '{"StatusCode":0,"StatusMessage":"success"}'],
  '/feishu-bad': [200, '{"code":9499,"msg":"param invalid"}'],
  '/slack-ok': [200, 'ok'],
  '/slack-400': [400, 'invalid_payload'],
  '/telegram-ok': [200, '{"ok":true,"result":{"message_id":1}}'],
  '/telegram-bad': [200, '{"ok":false,"description":"chat not found"}'],
  '/generic-ok': [202, '{"accepted":true}'],
  '/generic-500': [500, 'boom'],
};

createServer({ cert, key }, (request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = '<not json>';
    }
    // The body is a monitor alert payload, never a credential.
    appendFileSync(logFile, `${JSON.stringify({
      path: request.url,
      method: request.method,
      contentType: request.headers['content-type'],
      userAgent: request.headers['user-agent'],
      body: parsed,
    })}\n`);
    const [status, body] = responses[request.url] || [404, 'no route'];
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
}).listen(port, '127.0.0.1', () => console.log(`sink listening on 127.0.0.1:${port}`));
