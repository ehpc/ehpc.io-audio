import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// A real Unix-socket SMTP receiver; messages are available to Playwright workers.
export async function startAuthSmtp(directory) {
  const socketPath = resolve(directory, 'smtp.sock');
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP\r\n');
    let buffer = '';
    let recipient = '';
    let data = false;
    let message = [];
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            data = false;
            const body = message.join('\n');
            const code = body.match(/Your verification code is (\d{6})\./)?.[1];
            if (!code || !recipient) { socket.write('451 Invalid message\r\n'); continue; }
            void writeFile(resolve(directory, `mail-${encodeURIComponent(recipient)}.txt`), code)
              .then(() => socket.write('250 Message accepted\r\n'), () => socket.write('451 Delivery failed\r\n'));
          } else message.push(line);
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write('250 localhost\r\n');
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 OK\r\n');
        else if (/^RCPT TO:/i.test(line)) { recipient = line.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? ''; socket.write('250 OK\r\n'); }
        else if (/^DATA$/i.test(line)) { data = true; message = []; socket.write('354 End with dot\r\n'); }
        else if (/^QUIT$/i.test(line)) { socket.end('221 Bye\r\n'); }
        else if (/^RSET$/i.test(line)) { recipient = ''; socket.write('250 OK\r\n'); }
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  return { socketPath, stop: () => new Promise(resolve => server.close(resolve)) };
}
