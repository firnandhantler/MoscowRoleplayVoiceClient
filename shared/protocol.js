/**
 * Общий протокол обмена сообщениями между сервером и клиентом.
 *
 * Файл не зависит от Node.js или браузера, чтобы его можно было использовать
 * и в серверном коде, и в Electron-клиенте.
 *
 * Формат сообщения:
 * {
 *   "v": 1,
 *   "type": "client.ping",
 *   "id": "необязательный-идентификатор",
 *   "data": { ... }
 * }
 *
 * Правила:
 * - версия протокола обязательна и должна совпадать с PROTOCOL_VERSION;
 * - тип сообщения обязателен и должен входить в список разрешённых;
 * - идентификатор необязателен, но если указан — должен быть безопасной строкой;
 * - data необязательна, но если указана — должна быть объектом;
 * - неизвестные поля запрещены, чтобы не создавать неоднозначность.
 *
 * Протокол не описывает права доступа: любые действия (передача голоса,
 * радио, proximity) проверяются на сервере. Клиентские сообщения — только запросы.
 */

export const PROTOCOL_NAME = 'moscowroleplay-voice';
export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_MESSAGE_ID_LENGTH = 64;
export const MAX_NONCE_LENGTH = 64;
export const MAX_IDENTIFIER_LENGTH = 64;

/** Типы сообщений, которые клиент может отправить серверу. */
export const ClientMessageType = Object.freeze({
  PING: 'client.ping',
  AUTHENTICATE: 'client.authenticate',
  VOICE_CREATE_TRANSPORT: 'client.voice.createTransport',
  VOICE_CONNECT_TRANSPORT: 'client.voice.connectTransport',
  VOICE_PRODUCE: 'client.voice.produce',
  VOICE_CLOSE_PRODUCER: 'client.voice.closeProducer',
  VOICE_SET_MUTED: 'client.voice.setMuted',
  RADIO_JOIN: 'client.radio.join',
  RADIO_LEAVE: 'client.radio.leave',
  RADIO_START_TRANSMISSION: 'client.radio.startTransmission',
  RADIO_STOP_TRANSMISSION: 'client.radio.stopTransmission',
});

/** Источники аудиопотока. Proximity и радио — независимые Producers. */
export const AudioSource = Object.freeze({
  PROXIMITY: 'proximity',
  RADIO: 'radio',
});

/** Направление WebRTC-транспорта mediasoup. */
export const TransportDirection = Object.freeze({
  SEND: 'send',
  RECV: 'recv',
});

/** Типы сообщений, которые сервер может отправить клиенту. */
export const ServerMessageType = Object.freeze({
  HELLO: 'server.hello',
  PONG: 'server.pong',
  ERROR: 'server.error',
  AUTHENTICATED: 'server.authenticated',
  VOICE_TRANSPORT_CREATED: 'server.voice.transportCreated',
  VOICE_TRANSPORT_CONNECTED: 'server.voice.transportConnected',
  VOICE_PRODUCED: 'server.voice.produced',
  VOICE_PRODUCER_CLOSED: 'server.voice.producerClosed',
  VOICE_CONSUMER_CREATED: 'server.voice.consumerCreated',
  VOICE_CONSUMER_CLOSED: 'server.voice.consumerClosed',
  VOICE_MUTED: 'server.voice.muted',
  RADIO_STATE: 'server.radio.state',
  RADIO_TRANSMISSION: 'server.radio.transmission',
  PROXIMITY_STATE: 'server.proximity.state',
  GAME_STATE: 'server.game.state',
});

/** Машиночитаемые коды ошибок протокола. */
export const ProtocolErrorCode = Object.freeze({
  INVALID_JSON: 'invalid_json',
  INVALID_MESSAGE: 'invalid_message',
  UNSUPPORTED_VERSION: 'unsupported_protocol_version',
  UNSUPPORTED_TYPE: 'unsupported_message_type',
  MESSAGE_TOO_LARGE: 'message_too_large',
  BINARY_NOT_SUPPORTED: 'binary_not_supported',
  RATE_LIMITED: 'rate_limited',
  NOT_AUTHENTICATED: 'not_authenticated',
  INTERNAL_ERROR: 'internal_error',
  SERVER_SHUTTING_DOWN: 'server_shutting_down',
});

const CLIENT_MESSAGE_TYPES = new Set(Object.values(ClientMessageType));
const ALLOWED_ENVELOPE_KEYS = new Set(['v', 'type', 'id', 'data']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyAllowedKeys(object, allowedKeys) {
  return Object.keys(object).every((key) => allowedKeys.has(key));
}

function fail(code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function invalid(message) {
  return fail(ProtocolErrorCode.INVALID_MESSAGE, message);
}

/**
 * Проверяет строковый идентификатор (transportId, producerId, channelId).
 *
 * @param {unknown} value
 * @param {string} name
 * @param {string[]} errors
 */
function checkIdentifier(value, name, errors) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    errors.push(`Поле ${name} должно быть строкой [A-Za-z0-9_-] длиной до 64 символов.`);
  }
}

/**
 * Ограниченная проверка структуры RTP-параметров.
 * Глубокая проверка выполняется mediasoup: сервер не доверяет значениям,
 * а передаёт их в библиотеку, которая отклонит некорректный формат.
 *
 * @param {unknown} value
 * @param {string} name
 * @param {string[]} errors
 */
function checkRtpParameters(value, name, errors) {
  if (!isPlainObject(value)) {
    errors.push(`Поле ${name} должно быть объектом.`);
    return;
  }

  if (!Array.isArray(value.codecs) || value.codecs.length === 0 || value.codecs.length > 8) {
    errors.push(`Поле ${name}.codecs должно содержать от 1 до 8 кодеков.`);
  }

  if (!Array.isArray(value.headerExtensions) || value.headerExtensions.length > 32) {
    errors.push(`Поле ${name}.headerExtensions должно быть массивом до 32 элементов.`);
  }

  if (!Array.isArray(value.encodings)) {
    errors.push(`Поле ${name}.encodings должно быть массивом.`);
  }
}

/**
 * Проверяет структуру DTLS-параметров, полученных от клиента.
 * Значения передаются mediasoup без изменений.
 *
 * @param {unknown} value
 * @param {string} name
 * @param {string[]} errors
 */
function checkDtlsParameters(value, name, errors) {
  if (!isPlainObject(value)) {
    errors.push(`Поле ${name} должно быть объектом.`);
    return;
  }

  if (typeof value.role !== 'string' || !['auto', 'client', 'server'].includes(value.role)) {
    errors.push(`Поле ${name}.role должно быть auto, client или server.`);
  }

  if (!Array.isArray(value.fingerprints) || value.fingerprints.length === 0) {
    errors.push(`Поле ${name}.fingerprints должно быть непустым массивом.`);
  }
}

/**
 * Валидаторы `data` для каждого типа клиентского сообщения.
 * Каждый валидатор возвращает массив ошибок (пустой — сообщение корректно).
 */
const DATA_VALIDATORS = new Map([
  [
    ClientMessageType.PING,
    (data, errors) => {
      if (!hasOnlyAllowedKeys(data, new Set(['nonce']))) {
        errors.push('Сообщение содержит недопустимые поля данных.');
        return;
      }

      if (Object.hasOwn(data, 'nonce')) {
        if (typeof data.nonce !== 'string' || data.nonce.length > MAX_NONCE_LENGTH) {
          errors.push('Поле nonce должно быть строкой длиной не более 64 символов.');
        }
      }
    },
  ],
  [
    ClientMessageType.AUTHENTICATE,
    (data, errors) => {
      if (!hasOnlyAllowedKeys(data, new Set(['token']))) {
        errors.push('Сообщение содержит недопустимые поля данных.');
        return;
      }

      if (typeof data.token !== 'string' || !SESSION_TOKEN_PATTERN.test(data.token)) {
        errors.push('Поле token должно содержать токен сессии.');
      }
    },
  ],
  [
    ClientMessageType.VOICE_CREATE_TRANSPORT,
    (data, errors) => {
      if (!hasOnlyAllowedKeys(data, new Set(['direction']))) {
        errors.push('Сообщение содержит недопустимые поля данных.');
        return;
      }

      if (!Object.values(TransportDirection).includes(data.direction)) {
        errors.push('Поле direction должно быть send или recv.');
      }
    },
  ],
  [
    ClientMessageType.VOICE_CONNECT_TRANSPORT,
    (data, errors) => {
      if (!hasOnlyAllowedKeys(data, new Set(['transportId', 'dtlsParameters']))) {
        errors.push('Сообщение содержит недопустимые поля данных.');
        return;
      }

      checkIdentifier(data.transportId, 'transportId', errors);
      checkDtlsParameters(data.dtlsParameters, 'dtlsParameters', errors);
    },
  ],
  [
    ClientMessageType.VOICE_PRODUCE,
    (data, errors) => {
      if (
        !hasOnlyAllowedKeys(
          data,
          new Set(['transportId', 'kind', 'rtpParameters', 'source']),
        )
      ) {
        errors.push('Сообщение содержит недопустимые поля данных.');
        return;
      }

      checkIdentifier(data.transportId, 'transportId', errors);

      if (data.kind !== 'audio') {
        errors.push('Поддерживается только аудио (kind = "audio").');
      }

      if (!Object.values(AudioSource).includes(data.source)) {
        errors.push('Поле source должно быть proximity или radio.');
      }

      checkRtpParameters(data.rtpParameters, 'rtpParameters', errors);
    },
  ],
  [
    ClientMessageType.VOICE_CLOSE_PRODUCER,
    (data, errors) => {
      if (!hasOnlyAllowedKeys(data, new Set(['producerId']))) {
        errors.push('Сообщение содержит недопустимые поля данных.');
        return;
      }

      checkIdentifier(data.producerId, 'producerId', errors);
    },
  ],
  [
    ClientMessageType.VOICE_SET_MUTED,
    (data, errors) => {
      if (!hasOnlyAllowedKeys(data, new Set(['muted']))) {
        errors.push('Сообщение содержит недопустимые поля данных.');
        return;
      }

      if (typeof data.muted !== 'boolean') {
        errors.push('Поле muted должно быть boolean.');
      }
    },
  ],
  [
    ClientMessageType.RADIO_JOIN,
    (data, errors) => validateChannelId(data, errors),
  ],
  [
    ClientMessageType.RADIO_LEAVE,
    (data, errors) => validateChannelId(data, errors),
  ],
  [
    ClientMessageType.RADIO_START_TRANSMISSION,
    (data, errors) => validateChannelId(data, errors),
  ],
  [
    ClientMessageType.RADIO_STOP_TRANSMISSION,
    (data, errors) => validateChannelId(data, errors),
  ],
]);

/**
 * @param {object} data
 * @param {string[]} errors
 */
function validateChannelId(data, errors) {
  if (!hasOnlyAllowedKeys(data, new Set(['channelId']))) {
    errors.push('Сообщение содержит недопустимые поля данных.');
    return;
  }

  checkIdentifier(data.channelId, 'channelId', errors);
}

function validateData(type, data) {
  const validator = DATA_VALIDATORS.get(type);

  if (!validator) {
    return fail(
      ProtocolErrorCode.UNSUPPORTED_TYPE,
      'Этот тип сообщения пока не поддерживается сервером.',
    );
  }

  const errors = [];
  validator(data, errors);

  if (errors.length > 0) {
    return invalid(errors[0]);
  }

  return { ok: true };
}

/**
 * Разбирает и валидирует текстовое сообщение клиента.
 *
 * @param {unknown} raw Сырое значение, полученное от WebSocket.
 * @returns {{ok: true, message: {v: number, type: string, id: string|null, data: object}}
 *   | {ok: false, error: {code: string, message: string}}}
 */
export function parseClientMessage(raw) {
  if (typeof raw !== 'string') {
    return fail(
      ProtocolErrorCode.BINARY_NOT_SUPPORTED,
      'Двоичные сообщения не поддерживаются. Отправьте текстовый JSON.',
    );
  }

  const byteLength = textEncoder.encode(raw).byteLength;

  if (byteLength > MAX_MESSAGE_BYTES) {
    return fail(
      ProtocolErrorCode.MESSAGE_TOO_LARGE,
      'Сообщение превышает допустимый размер.',
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(
      ProtocolErrorCode.INVALID_JSON,
      'Сообщение не является корректным JSON.',
    );
  }

  if (!isPlainObject(parsed)) {
    return fail(
      ProtocolErrorCode.INVALID_MESSAGE,
      'Сообщение должно быть JSON-объектом.',
    );
  }

  if (!hasOnlyAllowedKeys(parsed, ALLOWED_ENVELOPE_KEYS)) {
    return fail(
      ProtocolErrorCode.INVALID_MESSAGE,
      'Сообщение содержит недопустимые поля.',
    );
  }

  if (parsed.v !== PROTOCOL_VERSION) {
    return fail(
      ProtocolErrorCode.UNSUPPORTED_VERSION,
      `Поддерживается только версия протокола ${PROTOCOL_VERSION}.`,
    );
  }

  if (typeof parsed.type !== 'string' || !CLIENT_MESSAGE_TYPES.has(parsed.type)) {
    return fail(
      ProtocolErrorCode.UNSUPPORTED_TYPE,
      'Неизвестный или неподдерживаемый тип сообщения.',
    );
  }

  let id = null;

  if (Object.hasOwn(parsed, 'id')) {
    if (typeof parsed.id !== 'string' || !ID_PATTERN.test(parsed.id)) {
      return fail(
        ProtocolErrorCode.INVALID_MESSAGE,
        'Идентификатор сообщения должен соответствовать шаблону [A-Za-z0-9_-] и иметь длину до 64 символов.',
      );
    }

    id = parsed.id;
  }

  let data = {};

  if (Object.hasOwn(parsed, 'data')) {
    if (!isPlainObject(parsed.data)) {
      return fail(
        ProtocolErrorCode.INVALID_MESSAGE,
        'Поле data должно быть JSON-объектом.',
      );
    }

    data = parsed.data;
  }

  const dataValidation = validateData(parsed.type, data);

  if (!dataValidation.ok) {
    return dataValidation;
  }

  return {
    ok: true,
    message: {
      v: PROTOCOL_VERSION,
      type: parsed.type,
      id,
      data,
    },
  };
}

/**
 * Создаёт объект серверного сообщения.
 *
 * @param {string} type Тип из ServerMessageType.
 * @param {object} data Полезная нагрузка.
 * @param {string|null} id Идентификатор исходного сообщения клиента.
 * @returns {{v: number, type: string, data: object, id?: string}}
 */
export function createServerMessage(type, data = {}, id = null) {
  const message = {
    v: PROTOCOL_VERSION,
    type,
    data,
  };

  if (id) {
    message.id = id;
  }

  return message;
}

/**
 * Проверяет, является ли значение допустимым идентификатором сообщения.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMessageId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
