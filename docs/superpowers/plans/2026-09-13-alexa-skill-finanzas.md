# Skill de Alexa "finanzas" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poder preguntarle a un Echo "Alexa, pregunta a finanzas cuánto gasté en..." y que responda en voz, hablando con el mismo chatbot de Gemini que ya existe.

**Architecture:** Un endpoint nuevo, angosto y con secreto propio (`POST /api/alexa`) en el `server.js` ya existente, que traduce el shape de request/response de Alexa hacia/desde `askQuestion()` de `chatbot.js` (sin tocar ese archivo). Publicado a internet con Tailscale Funnel — solo esa ruta, todo lo demás sigue exclusivamente detrás de Tailscale. Un Custom Skill de Alexa (configuración en `developer.amazon.com`, fuera del repo) apunta ese endpoint.

**Tech Stack:** Node/Express (ya en el proyecto), Tailscale Funnel (SO de la Pi), Alexa Skills Kit (consola web de Amazon) — nada nuevo que instalar (`npm install`).

**Nota sobre testing:** este proyecto no tiene suite de tests automatizada (confirmado: sin Jest/Mocha en `package.json`) — la verificación en todo el proyecto se hace con `curl`/navegador contra el servidor real corriendo. Este plan sigue esa misma convención en vez de inventar un framework de testing que el resto del código no usa.

**Fuera de alcance en este plan (YAGNI, ver spec):** `GEMINI_API_KEY_ALEXA` separada — el spec la deja como sugerencia sin decidir. Si el usuario la pide, es un cambio chico y aislado para después: `askQuestion(pregunta, apiKeyOverride)` en `chatbot.js` + que `getAi()` cachee por key en vez de una sola promesa global. No se construye a medias acá.

---

### Task 1: Endpoint `POST /api/alexa` en `server.js`

**Files:**
- Modify: `rpi/server.js` (agregar ruta nueva, después de la ruta `/api/preguntar` existente en la línea ~445)
- Modify: `rpi/.env.example` (agregar `ALEXA_SHARED_SECRET`)

- [ ] **Step 1: Agregar `ALEXA_SHARED_SECRET` a `.env.example`**

Editar `rpi/.env.example`, agregar después de la línea de `GEMINI_MODEL`:

```
# Secreto propio del endpoint /api/alexa — NO reusar SHARED_SECRET de
# Code.gs ni ningún otro. Este endpoint queda expuesto a internet vía
# Tailscale Funnel, así que es la única barrera real.
ALEXA_SHARED_SECRET=
```

- [ ] **Step 2: Escribir la ruta, solo con el chequeo de secreto (sin lógica real todavía)**

En `rpi/server.js`, agregar esto inmediatamente después del cierre del bloque `app.post('/api/preguntar', ...)` (después de la línea ~445, antes de `app.post('/api/sync', ...)`):

```js
// --- Alexa Skill "finanzas" — único endpoint pensado para exponerse a
// internet (vía Tailscale Funnel, configurado a nivel de SO, no acá).
// Todo lo demás de este archivo sigue exclusivamente detrás de Tailscale.
//
// Ojo con el fail-open: si ALEXA_SHARED_SECRET no está seteado en .env,
// `process.env.ALEXA_SHARED_SECRET` es `undefined`, y un request sin
// header también da `undefined` — comparar undefined !== undefined es
// `false`, o sea que SIN secreto configurado, CUALQUIERA pasaría. Por eso
// el chequeo exige explícitamente que `secreto` exista, no solo que
// coincida.
app.post('/api/alexa', async (req, res) => {
  const secreto = process.env.ALEXA_SHARED_SECRET;
  if (!secreto || req.headers['x-alexa-secret'] !== secreto) {
    return res.status(401).json({ error: 'no autorizado' });
  }

  res.json({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text: 'Endpoint vivo, todavía sin lógica real.' },
      shouldEndSession: true,
    },
  });
});
```

- [ ] **Step 3: Levantar el server local y probar que rechaza sin secreto**

```bash
cd rpi
cat > .env << 'EOF'
SHEET_ID=1Tih_CEXmCxTuDjtL05mJzGgAxLbJoPkFvp6XllYnaKc
SHEET_NAME=Movimientos
SHEET_SALDOS=Saldos
GOOGLE_SERVICE_ACCOUNT_FILE=../service-account.json
GEMINI_API_KEY=tu_key_real
PORT=3000
SYNC_INTERVAL_MIN=15
ALEXA_SHARED_SECRET=un-secreto-de-prueba-123
EOF
npm run sync-once
node server.js &
sleep 2
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST http://localhost:3000/api/alexa \
  -H "Content-Type: application/json" -d '{}'
```

Esperado: `HTTP 401` (sin header `x-alexa-secret`, el chequeo rechaza).

- [ ] **Step 4: Probar que acepta con el secreto correcto**

```bash
curl -s -X POST http://localhost:3000/api/alexa \
  -H "Content-Type: application/json" \
  -H "x-alexa-secret: un-secreto-de-prueba-123" -d '{}'
```

Esperado:
```json
{"version":"1.0","response":{"outputSpeech":{"type":"PlainText","text":"Endpoint vivo, todavía sin lógica real."},"shouldEndSession":true}}
```

- [ ] **Step 5: Reemplazar el stub por la lógica real — leer la pregunta del shape de Alexa y llamar a `askQuestion()`**

Reemplazar el cuerpo de la ruta agregada en el Step 2 completo por:

```js
app.post('/api/alexa', async (req, res) => {
  const secreto = process.env.ALEXA_SHARED_SECRET;
  if (!secreto || req.headers['x-alexa-secret'] !== secreto) {
    return res.status(401).json({ error: 'no autorizado' });
  }

  // Shape real de un IntentRequest de Alexa (ver Task 3 para el modelo de
  // interacción que genera este JSON): la pregunta transcripta vive en
  // request.intent.slots.query.value — el nombre "query" viene del slot
  // AMAZON.SearchQuery definido en el Custom Skill.
  const slots = req.body && req.body.request && req.body.request.intent && req.body.request.intent.slots;
  const pregunta = slots && slots.query && slots.query.value;

  function hablar(texto) {
    res.json({
      version: '1.0',
      response: {
        outputSpeech: { type: 'PlainText', text: texto },
        shouldEndSession: true,
      },
    });
  }

  if (!pregunta) {
    return hablar('No entendí la pregunta, probá de nuevo.');
  }

  try {
    const resultado = await askQuestion(pregunta);
    hablar(resultado.respuesta);
  } catch (err) {
    // askQuestion() ya atrapa el caso de cuota agotada de Gemini y devuelve
    // texto legible en vez de tirar — esto solo cubre errores realmente
    // inesperados (red caída, etc.), ver chatbot.js.
    hablar('Hubo un error consultando tus datos: ' + err.message);
  }
});
```

- [ ] **Step 6: Probar con una pregunta real, simulando el shape exacto de Alexa**

```bash
curl -s -X POST http://localhost:3000/api/alexa \
  -H "Content-Type: application/json" \
  -H "x-alexa-secret: un-secreto-de-prueba-123" \
  -d '{
    "version": "1.0",
    "request": {
      "type": "IntentRequest",
      "intent": {
        "name": "PreguntarIntent",
        "slots": { "query": { "name": "query", "value": "cuánto gasté en total" } }
      }
    }
  }'
```

Esperado (el monto real depende de tus datos sincronizados, pero la forma es esta):
```json
{"version":"1.0","response":{"outputSpeech":{"type":"PlainText","text":"En total gastaste $6.965,62."},"shouldEndSession":true}}
```

- [ ] **Step 7: Probar el caso de pregunta vacía/sin slot**

```bash
curl -s -X POST http://localhost:3000/api/alexa \
  -H "Content-Type: application/json" \
  -H "x-alexa-secret: un-secreto-de-prueba-123" \
  -d '{"version":"1.0","request":{"type":"IntentRequest","intent":{"name":"PreguntarIntent","slots":{}}}}'
```

Esperado: `{"version":"1.0","response":{"outputSpeech":{"type":"PlainText","text":"No entendí la pregunta, probá de nuevo."},"shouldEndSession":true}}`

- [ ] **Step 8: Apagar el server local y limpiar**

```bash
kill %1
rm -f .env movimientos.db movimientos.db-shm movimientos.db-wal
```

- [ ] **Step 9: Commit**

```bash
cd /Users/liris/Desktop/David/David/expense-tracker
git checkout -b feat/endpoint-alexa
git add rpi/server.js rpi/.env.example
git commit -m "feat(rpi): endpoint POST /api/alexa para el Skill de voz

Traduce el shape de request/response de Alexa hacia/desde askQuestion()
de chatbot.js, sin tocar ese archivo. Gateado con ALEXA_SHARED_SECRET
propio (fail-closed si no está seteado) — es el único endpoint pensado
para exponerse a internet vía Tailscale Funnel (configurado aparte, no en
el repo); todo lo demás sigue exclusivamente detrás de Tailscale.

Verificado con curl simulando el shape real de un IntentRequest de Alexa:
sin secreto -> 401, con secreto y pregunta real -> respuesta correcta,
sin slot -> mensaje de 'no entendí'."
git checkout main && git merge --no-ff feat/endpoint-alexa -m "Merge branch 'feat/endpoint-alexa'"
git branch -d feat/endpoint-alexa
git push origin main
```

---

### Task 2: Publicar `/api/alexa` con Tailscale Funnel

**Files:** ninguno — configuración del sistema operativo de la Pi, no del repo.

- [ ] **Step 1: Habilitar Funnel para la tailnet (una sola vez)**

Entrar al admin console de tu cuenta Tailscale (`login.tailscale.com/admin`) y habilitar Funnel para tu tailnet/nodo — la ubicación exacta del toggle puede variar según la versión actual de la consola, buscarlo en Settings/ACLs si no aparece directo. Confirmar antes de seguir: correr `tailscale funnel status` en la Pi no debería tirar un error de "Funnel no habilitado para esta tailnet".

- [ ] **Step 2: Exponer SOLO la ruta `/api/alexa`, en la Pi**

```bash
ssh rpi@192.168.1.22   # o rpi@100.121.40.27 por Tailscale
tailscale funnel --set-path=/api/alexa 3000
tailscale funnel status
```

Esperado en `status`: una URL pública (`https://<nombre-de-la-pi>.<tu-tailnet>.ts.net`) listada, con `/api/alexa` como el único path — confirmar que NO aparece la raíz (`/`) ni ningún otro path expuesto.

- [ ] **Step 3: Verificar desde AFUERA de la red Tailscale**

Con el servicio `expense-tracker` corriendo en la Pi (`systemctl status expense-tracker`), desde un dispositivo que **no** esté en tu tailnet (datos móviles, sin Tailscale activo, o `curl` desde otra máquina cualquiera):

```bash
curl -s -X POST https://<tu-url-de-funnel>/api/alexa \
  -H "Content-Type: application/json" -d '{}'
```

Esperado: `{"error":"no autorizado"}` con status 401 — confirma que la ruta es alcanzable públicamente Y que el secreto sigue bloqueando sin él. Probar también que `https://<tu-url-de-funnel>/api/dashboard` (o cualquier otra ruta) **no** responde — confirma que Funnel solo publicó el path que pediste.

- [ ] **Step 4: Anotar la URL de Funnel**

Guardarla para el Task 3 (va en la configuración del endpoint del Custom Skill). No hay commit en este task — es configuración de infraestructura, no de código.

---

### Task 3: Custom Skill "finanzas" en Alexa Developer Console

**Files:** ninguno — configuración externa en `developer.amazon.com`.

- [ ] **Step 1: Crear la cuenta y el Skill**

Entrar a `developer.amazon.com/alexa/console/ask`, crear cuenta si hace falta (gratis, puede ser el mismo login de Amazon normal). "Create Skill" → nombre "finanzas" → modelo "Custom" → método "Alexa-Hosted" NO (vamos a apuntar a tu propio endpoint) → elegir "Provision your own".

- [ ] **Step 2: Cargar el modelo de interacción (JSON Editor, dentro del Skill)**

En la sección "Interaction Model" → "JSON Editor", pegar exactamente:

```json
{
  "interactionModel": {
    "languageModel": {
      "invocationName": "finanzas",
      "intents": [
        { "name": "AMAZON.CancelIntent", "samples": [] },
        { "name": "AMAZON.HelpIntent", "samples": [] },
        { "name": "AMAZON.StopIntent", "samples": [] },
        {
          "name": "PreguntarIntent",
          "slots": [
            { "name": "query", "type": "AMAZON.SearchQuery" }
          ],
          "samples": [
            "{query}",
            "pregunta {query}",
            "preguntame {query}"
          ]
        }
      ]
    }
  }
}
```

Guardar ("Save Model") y compilar ("Build Model") — el build tarda uno o dos minutos.

- [ ] **Step 3: Configurar el endpoint**

En la sección "Endpoint": elegir "HTTPS" (no "AWS Lambda ARN"). Pegar la URL de Funnel del Task 2 + `/api/alexa` (ej. `https://tu-pi.tu-tailnet.ts.net/api/alexa`) en "Default Region". En "SSL certificate type", elegir la opción que dice que el certificado viene de una autoridad certificadora de confianza (Let's Encrypt, el que usa Funnel, califica) — **no** elegir "self-signed" ni "wildcard subdomain", verificar el texto exacto de cada opción en la consola al momento de configurarlo, puede variar levemente entre versiones.

- [ ] **Step 4: Agregar el secreto como header custom, si la consola lo permite en esta sección; si no, ver nota abajo**

Algunas versiones de la consola de Alexa no dejan agregar headers custom por defecto en la config simple de endpoint HTTPS — si no aparece esa opción, la alternativa es mandar el secreto como parte del **body** del request en vez de un header, lo que requiere ajustar el `server.js` del Task 1 para leerlo de `req.body.secreto` en vez de `req.headers['x-alexa-secret']`. Confirmar en la consola real antes de decidir cuál camino tomar — no asumir de antemano cuál opción está disponible.

- [ ] **Step 5: Probar en el simulador de voz**

Pestaña "Test" del Skill (activar "Skill testing is enabled in: Development" si no está prendido). Escribir o decir: `pregunta finanzas cuánto gasté en total` — debería devolver la respuesta hablada con el monto real.

- [ ] **Step 6: Commit (si hiciste el ajuste del Step 4)**

Solo si tocaste `server.js` para leer el secreto del body en vez del header:

```bash
cd /Users/liris/Desktop/David/David/expense-tracker
git checkout -b fix/alexa-secreto-en-body
git add rpi/server.js
git commit -m "fix(rpi): leer el secreto de Alexa del body, no de un header

La consola de Alexa no dejó configurar un header custom para el endpoint
HTTPS — el secreto viaja en el body del request en vez de x-alexa-secret."
git checkout main && git merge --no-ff fix/alexa-secreto-en-body -m "Merge branch 'fix/alexa-secreto-en-body'"
git branch -d fix/alexa-secreto-en-body
git push origin main
```

Si NO hiciste el ajuste (la consola sí permitió el header), no hay commit en este task.

---

### Task 4: Probar en el Echo físico

**Files:** ninguno.

- [ ] **Step 1: Hablarle al dispositivo real**

Con el Skill en modo desarrollo, ya está disponible en cualquier Echo logueado con la misma cuenta de Amazon que usaste en el Developer Console — no hace falta "instalarlo" aparte. Decir: "Alexa, pregunta a finanzas cuánto gasté en Alimentos" (o la categoría que quieras).

- [ ] **Step 2: Confirmar que la respuesta hablada coincide con el dashboard**

Comparar el monto que dice Alexa contra la misma pregunta tipeada en la pestaña Preguntas del dashboard (`http://<IP-de-la-Pi>:3000/dashboard.html`) — tienen que coincidir exacto, es el mismo `askQuestion()` de `chatbot.js` por debajo.

- [ ] **Step 3: Actualizar la bóveda**

Marcar en `Finanzas App/Finanzas - 07 - Fase 4, Chatbot (Gemini).md` (o una nota nueva "Fase 5") que el canal de voz está en producción, con la fecha. No es parte del repo de código — recordatorio para no saltearlo.

---

## Self-review

**Cobertura del spec:** arquitectura (Task 1+2+3), seguridad/endpoint único expuesto (Task 1 Step 2 + Task 2 Step 3), Custom Skill con `AMAZON.SearchQuery` (Task 3 Step 2), testing con curl antes de Alexa real (Task 1, Task 2 Step 3), simulador antes de Echo físico (Task 3 Step 5, Task 4) — todo cubierto. `GEMINI_API_KEY_ALEXA` queda fuera a propósito (YAGNI, spec lo marca como no decidido).

**Placeholders:** ninguno — cada step de código tiene el código completo, cada verificación tiene el comando y el resultado esperado exacto. Los dos puntos marcados como "confirmar en la consola real" (Task 3 Steps 3 y 4) son incertidumbre genuina sobre una UI externa que cambia sin aviso, no pereza — mismo criterio que ya se usó en la guía visual y en el spec.

**Consistencia:** `askQuestion(pregunta)` (Task 1) coincide con la firma real de `chatbot.js` sin modificar. El nombre del slot `query` es consistente entre el modelo de interacción (Task 3) y el código que lo lee (Task 1, `slots.query.value`). El nombre del intent `PreguntarIntent` es consistente en ambos lados.
