#!/usr/bin/env node
// Gera bookmarklet.txt (o código "javascript:..." do favorito) e index.html
// (página para abrir no iPhone e copiar o código com um toque).
// Uso: node build.js
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const src = fs.readFileSync(path.join(dir, 'video-downloader.js'), 'utf8');

// Minificação simples: tira comentários de bloco, comentários de linha
// inteira e indentação. As quebras de linha ficam (viram %0A), então
// comentários no fim da linha não quebram nada.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//'))
  .join('\n');

new Function(code); // falha aqui se a minificação quebrar a sintaxe

// '#' precisa ser codificado, senão vira fragmento da URL e corta o código.
const bookmarklet = 'javascript:' + encodeURI(code).replace(/#/g, '%23');
fs.writeFileSync(path.join(dir, 'bookmarklet.txt'), bookmarklet + '\n');

const html = fs
  .readFileSync(path.join(dir, 'install.template.html'), 'utf8')
  .replace('__BOOKMARKLET_JSON__', () => JSON.stringify(bookmarklet).replace(/</g, '\\u003c'));
fs.writeFileSync(path.join(dir, 'index.html'), html);

console.log(`bookmarklet.txt: ${bookmarklet.length} caracteres`);
