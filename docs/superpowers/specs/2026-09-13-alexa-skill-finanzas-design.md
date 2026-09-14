# Skill de Alexa "finanzas" — preguntas por voz al chatbot existente

## Objetivo

Permitir "Alexa, pregunta a finanzas cuánto gasté en..." — voz como frontend
alternativo del chatbot de Gemini que ya existe (`POST /api/preguntar`, ver
[Finanzas - 07 - Fase 4, Chatbot (Gemini)] en la bóveda). Cero lógica de
IA/SQL nueva: Alexa transcribe la voz, la pregunta cruda viaja tal cual al
endpoint existente, la respuesta en texto vuelve leída en voz alta.

## Por qué

Mi Fitness/otras apps no dan esto — es la única ventaja real frente a "ya
existe una app que hace lo mismo" (mismo criterio que descartó el proyecto
del reloj). Es una extensión delgada sobre infraestructura ya construida,
no un proyecto nuevo de cero.

## Fuera de alcance (a propósito, YAGNI)

- Nada de AWS/Lambda — el Custom Skill apunta directo a un HTTPS propio.
- Nada de respuestas fijas/resumen sin IA — "solo preguntas", como se
  decidió en el brainstorm.
- Nada de rate limiting adicional en `/api/alexa` — el usuario lo
  consideró y decidió no agregarlo por ahora.
- No se publica el Skill a la tienda pública de Alexa — modo desarrollo,
  privado a la cuenta del usuario.

## Arquitectura

```
Usuario habla al Echo
      │
      ▼
Alexa (nube de Amazon) — intent con slot AMAZON.SearchQuery
      │ (texto libre transcripto, sin NLU propio de Alexa)
      ▼
HTTPS público — certificado válido vía Tailscale Funnel
      │
      ▼
POST /api/alexa  (nuevo, en rpi/server.js)
      │ valida ALEXA_SHARED_SECRET — 401 si no coincide o falta
      ▼
askQuestion(pregunta)  — chatbot.js, SIN CAMBIOS
      │
      ▼
Alexa lee `respuesta` en voz alta
```

## Componentes nuevos

### 1. `rpi/server.js` — endpoint `POST /api/alexa`

Recibe el formato de request que manda Alexa (`request.intent.slots.query.value`
para el texto, no el mismo shape que usa el frontend del dashboard). Valida
`ALEXA_SHARED_SECRET` contra un header o campo del body (a definir el
nombre exacto al implementar — Alexa no tiene un campo "secret" nativo,
así que probablemente vaya en un header custom). Llama a `askQuestion()`
tal cual, arma la respuesta en el formato JSON que Alexa espera
(`response.outputSpeech.text`), no el mismo shape que `/api/preguntar`.

### 2. `.env` — `ALEXA_SHARED_SECRET`, y opcionalmente `GEMINI_API_KEY_ALEXA`

Si se usa una key de Gemini separada para este canal (sugerido, no
obligatorio): `chatbot.js` necesita aceptar qué key usar por parámetro en
vez de leer siempre `process.env.GEMINI_API_KEY` — cambio chico,
retrocompatible (default a la de siempre si no se pasa otra).

### 3. Tailscale Funnel

Configurado a nivel del sistema operativo de la Pi, no en el repo —
expone solo la ruta `/api/alexa`, nada más. Documentar el comando exacto
en la bóveda (`Procedimiento`) al implementar, no asumido de memoria acá.

### 4. Alexa Custom Skill (Developer Console, fuera del repo)

- Cuenta gratis en `developer.amazon.com`.
- Invocation name: **"finanzas"** (default propuesto, cambiable).
- Un intent (`PreguntarIntent`) con un slot `query` tipo
  `AMAZON.SearchQuery`, utterance de muestra: `"{query}"` /
  `"pregunta {query}"`.
- Endpoint: HTTPS, la URL de Funnel + `/api/alexa`.

## Seguridad

- Todo lo demás (`/api/dashboard`, `/api/preguntar`, `/api/gastos`, etc.)
  sigue exclusivamente detrás de Tailscale, sin cambios.
- `/api/alexa` es el único punto expuesto a internet — gateado por
  `ALEXA_SHARED_SECRET` y de solo lectura (misma validación `SELECT`-only
  que ya tiene `chatbot.js`, sin relajar nada).

## Testing

- Probar `/api/alexa` con curl simulando el payload de Alexa antes de
  configurar el Skill real — evita depurar dos sistemas nuevos (Funnel +
  Alexa) a la vez.
- Probar el Skill desde el simulador de voz del Developer Console antes de
  probarlo con el Echo físico.

## Ver también

- Bóveda: `Finanzas App/Finanzas - 07 - Fase 4, Chatbot (Gemini).md`
- Bóveda: `Finanzas App/Decisiones/Decisión - Gemini en vez de Claude para el chatbot.md`
