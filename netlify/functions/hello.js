// netlify/functions/hello.js
export const handler = async () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ok: true, msg: 'hello from Netlify functions' }),
});
