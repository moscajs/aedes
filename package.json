{
  "name": "aedes",
  "version": "0.51.3",
  "description": "Stream-based MQTT broker",
  "main": "aedes.js",
  "types": "aedes.d.ts",
  "scripts": {
    "lint": "npm run lint:standard && npm run lint:typescript && npm run lint:markdown",
    "lint:fix": "standard --fix && eslint -c types/.eslintrc.json --fix aedes.d.ts types/**/*.ts test/types/**/*.test-d.ts",
    "lint:standard": "standard --verbose | snazzy",
    "lint:typescript": "eslint -c types/.eslintrc.json aedes.d.ts types/**/*.ts test/types/**/*.test-d.ts",
    "lint:markdown": "markdownlint docs/*.md README.md",
    "test": "npm run lint && npm run unit && npm run test:typescript",
    "test:ci": "npm run lint && npm run unit -- --cov --no-check-coverage --coverage-report=lcovonly && npm run test:typescript",
    "test:report": "npm run lint && npm run unit:report && npm run test:typescript",
    "test:typescript": "tsd",
    "unit": "tap -J test/*.js",
    "unit:report": "tap -J test/*.js --cov --coverage-report=html --coverage-report=cobertura | tee out.tap",
    "license-checker": "license-checker --production --onlyAllow=\"MIT;ISC;BSD-3-Clause;BSD-2-Clause;0BSD\"",
    "release": "read -p 'GITHUB_TOKEN: ' GITHUB_TOKEN && export GITHUB_TOKEN=$GITHUB_TOKEN && release-it --disable-metrics"
  },
  "release-it": {
    "github": {
      "release": true
    },
    "git": {
      "tagName": "v${version}"
    },
    "hooks": {
      "before:init": [
        "npm run test:ci"
      ]
    },
    "npm": {
      "publish": true
    }
  },
  "pre-commit": [
    "test"
  ],
  "tsd": {
    "directory": "test/types"
  },
  "standard": {
    "ignore": [
      "types/*",
      "test/types/*"
    ]
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/moscajs/aedes.git"
  },
  "keywords": [
    "mqtt",
    "broker",
    "server",
    "mqtt-server",
    "stream",
    "streams",
    "publish",
    "subscribe",
    "pubsub",
    "messaging",
    "mosca",
    "mosquitto",
    "iot",
    "internet",
    "of",
    "things"
  ],
  "author": "Matteo Collina <hello@matteocollina.com>",
  "contributors": [
    {
      "name": "Gavin D'mello",
      "url": "https://github.com/GavinDmello"
    },
    {
      "name": "Behrad Zari",
      "url": "https://github.com/behrad"
    },
    {
      "name": "Gnought",
      "url": "https://github.com/gnought"
    },
    {
      "name": "Daniel Lando",
      "url": "https://github.com/robertsLando"
    }
  ],
  "license": "MIT",
  "funding": {
    "type": "opencollective",
    "url": "https://opencollective.com/aedes"
  },
  "bugs": {
    "url": "https://github.com/moscajs/aedes/issues"
  },
  "homepage": "https://github.com/moscajs/aedes#readme",
  "engines": {
    "node": ">=16"
  },
  "devDependencies": {
    "@sinonjs/fake-timers": "^11.2.2",
    "@types/node": "^20.11.17",
    "@typescript-eslint/eslint-plugin": "^7.0.1",
    "@typescript-eslint/parser": "^7.0.1",
    "concat-stream": "^2.0.0",
    "duplexify": "^4.1.2",
    "license-checker": "^25.0.1",
    "markdownlint-cli": "^0.41.0",
    "mqtt": "^5.3.5",
    "mqtt-connection": "^4.1.0",
    "pre-commit": "^1.2.2",
    "proxyquire": "^2.1.3",
    "release-it": "^17.0.5",
    "snazzy": "^9.0.0",
    "standard": "^17.1.0",
    "tap": "^16.3.10",
    "tsd": "^0.31.0",
    "typescript": "^5.3.3",
    "websocket-stream": "^5.5.2"
  },
  "dependencies": {
    "aedes-packet": "^3.0.0",
    "aedes-persistence": "^9.1.2",
    "end-of-stream": "^1.4.4",
    "fastfall": "^1.5.1",
    "fastparallel": "^2.4.1",
    "fastseries": "^2.0.0",
    "hyperid": "^3.2.0",
    "mqemitter": "^6.0.0",
    "mqtt-packet": "^9.0.0",
    "retimer": "^4.0.0",
    "reusify": "^1.0.4",
    "uuid": "^10.0.0"
  }
}
