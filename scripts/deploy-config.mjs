import 'dotenv/config';
console.log(
  JSON.stringify({
    origin: process.env.PUBLIC_ORIGIN,
    cert: process.env.CADDY_TLS_CERT,
    key: process.env.CADDY_TLS_KEY,
    data: process.env.DATA_DIR || './data',
    port: process.env.PORT || '18474',
  }),
);
