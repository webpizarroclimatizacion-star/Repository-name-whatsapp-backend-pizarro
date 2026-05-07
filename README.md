# WhatsApp QR Backend para Base44

Backend Node.js para conectar WhatsApp Web por QR con tu CRM de Base44.

## Endpoints incluidos

- `POST /generate-qr`
- `POST /send-message`
- `POST /send-campaign`
- `POST /disconnect-session`
- `GET /session-status/:id`
- `GET /ping`

Todos requieren header:

```http
x-api-key: TU_API_KEY
```

## Instalación local

```bash
npm install
cp .env.example .env
npm start
```

## Variables de entorno

```env
PORT=3000
API_KEY=cambiar_esta_clave_segura
BASE44_WEBHOOK_URL=https://TU-BASE44.app/api/receive-message
BASE44_STATUS_WEBHOOK_URL=https://TU-BASE44.app/api/message-status
```

## En Base44

En Backend WA cargá:

- URL backend: `https://tu-url.up.railway.app`
- API Key: el valor de `API_KEY`
- Tipo: `whatsapp-web.js`

## Probar ping

```bash
curl -H "x-api-key: cambiar_esta_clave_segura" https://tu-url/ping
```

## Generar QR

```bash
curl -X POST https://tu-url/generate-qr \
  -H "Content-Type: application/json" \
  -H "x-api-key: cambiar_esta_clave_segura" \
  -d '{"session_id":"pizarro_tucuman","sucursal_id":"tucuman"}'
```

## Enviar mensaje

```bash
curl -X POST https://tu-url/send-message \
  -H "Content-Type: application/json" \
  -H "x-api-key: cambiar_esta_clave_segura" \
  -d '{"session_id":"pizarro_tucuman","telefono":"3812066499","mensaje":"Hola desde el CRM"}'
```

## Aviso importante

Esto usa WhatsApp Web automatizado, no la API oficial de Meta. Usalo con cuidado:
- no enviar spam
- usar delays
- evitar volúmenes grandes
- usar consentimiento de clientes
