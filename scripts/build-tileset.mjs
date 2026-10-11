#!/usr/bin/env node
// Gera o tileset do escritório em pixel art (16 px por tile):
//   public/assets/office.png + office.json   móveis, pisos e decoração (atlas do Phaser)
//   public/assets/chars.png                  personagens-modelo (recoloridos no navegador)
//
// Tudo é desenhado aqui, pixel a pixel, então não há licença de terceiros.
// Para trocar por outro tileset, gere um atlas com os mesmos nomes de frame.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');

// ---------------------------------------------------------------------------
// Paleta
// ---------------------------------------------------------------------------

const PALETTE = {
  '.': null,
  k: '#2b2433', // contorno
  w: '#ffffff',
  W: '#e8e6e1',
  g: '#c3c3cc',
  G: '#8f8f9c',
  d: '#5c5c6b',
  b: '#d6a66b', // madeira
  B: '#b07b48',
  n: '#7d5431',
  r: '#e0575a',
  R: '#a8323f',
  u: '#5f93db',
  U: '#3f67ad',
  c: '#8fe3ff', // tela ligada
  C: '#3aa0d8',
  o: '#ffad5c',
  O: '#d97a1f',
  y: '#ffd35c',
  Y: '#e0a92e',
  l: '#7ccf52',
  L: '#4ea33f',
  m: '#2f7233',
  p: '#d0703f',
  P: '#9a4a28',
  v: '#a77ad9',
  V: '#6f45a3',
  s: '#343b4a', // tela desligada
  S: '#232833',
  t: '#45c4b0',
  e: '#2b2433', // olhos
  z: '#3a3340', // sapatos
  // Cores-chave dos personagens, trocadas pelas cores de cada persona no navegador
  h: '#ff00ff',
  H: '#c000c0',
  f: '#00ffff',
  F: '#00c0c0',
  x: '#ffff00',
  X: '#c0c000',
  q: '#00ff00',
  Q: '#00c000',
};

function rgba(hex) {
  if (!hex) return [0, 0, 0, 0];
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

// ---------------------------------------------------------------------------
// Mini "canvas" de pixels
// ---------------------------------------------------------------------------

class Sprite {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
  }

  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return this;
    x = Math.round(x);
    y = Math.round(y);
    const c = typeof color === 'string' && color.length === 1 ? PALETTE[color] : color;
    this.px.set(rgba(c), (y * this.w + x) * 4);
    return this;
  }

  opaque(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.px[(y * this.w + x) * 4 + 3] > 0;
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
    return this;
  }

  // Retângulo com contorno escuro.
  box(x, y, w, h, fill, edge = 'k') {
    this.rect(x, y, w, h, edge);
    this.rect(x + 1, y + 1, w - 2, h - 2, fill);
    return this;
  }

  ellipse(cx, cy, rx, ry, c) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.set(x, y, c);
      }
    }
    return this;
  }

  map(rows, ox = 0, oy = 0) {
    rows.forEach((row, y) => {
      if (row.length !== rows[0].length) throw new Error(`linha ${y} com tamanho errado: "${row}"`);
      [...row].forEach((ch, x) => {
        if (!(ch in PALETTE)) throw new Error(`cor desconhecida "${ch}"`);
        if (ch !== '.') this.set(ox + x, oy + y, ch);
      });
    });
    return this;
  }

  // Contorna tudo que é opaco (bom para formas orgânicas como folhas).
  outline(c = 'k') {
    const edge = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.opaque(x, y)) continue;
        if (this.opaque(x + 1, y) || this.opaque(x - 1, y) || this.opaque(x, y + 1) || this.opaque(x, y - 1)) {
          edge.push([x, y]);
        }
      }
    }
    for (const [x, y] of edge) this.set(x, y, c);
    return this;
  }

  blit(src, ox, oy) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const i = (y * src.w + x) * 4;
        if (src.px[i + 3]) this.px.set(src.px.subarray(i, i + 4), ((oy + y) * this.w + ox + x) * 4);
      }
    }
  }
}

// Gerador pseudoaleatório com semente, para o tileset sair sempre igual.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

// ---------------------------------------------------------------------------
// Pisos e paredes
// ---------------------------------------------------------------------------

function tile(base, grout, extra) {
  const s = new Sprite(16, 16).rect(0, 0, 16, 16, base);
  s.rect(0, 15, 16, 1, grout).rect(15, 0, 1, 16, grout);
  extra?.(s);
  return s;
}

const sprites = {};

sprites.floor_room = tile('#ebe0cb', '#dccdb1', (s) => s.rect(1, 1, 3, 1, '#f3ead9'));
sprites.floor_room_alt = tile('#e5d8c0', '#dccdb1', (s) => s.rect(1, 1, 3, 1, '#ede2cd'));
sprites.floor_hall = tile('#f1efea', '#dedad1', (s) => s.rect(1, 1, 3, 1, '#faf9f6'));
sprites.floor_hall_alt = tile('#e9e6df', '#dedad1');

sprites.floor_wood = (() => {
  const s = new Sprite(16, 16);
  for (let y = 0; y < 16; y += 4) {
    s.rect(0, y, 16, 4, y % 8 ? '#c99563' : '#d1a06f');
    s.rect(0, y + 3, 16, 1, '#a8774a');
    s.rect(y % 8 ? 5 : 12, y, 1, 3, '#a8774a');
  }
  return s;
})();

for (const [name, base, dark] of [
  ['grass', '#7cc36a', '#6bb35a'],
  ['grass_alt', '#78bf65', '#68ae57'],
]) {
  const s = new Sprite(16, 16).rect(0, 0, 16, 16, base);
  for (let i = 0; i < 6; i++) {
    const x = Math.floor(rand() * 15);
    const y = Math.floor(rand() * 14) + 1;
    s.set(x, y, dark).set(x + 1, y - 1, dark);
  }
  if (name === 'grass_alt') s.set(4, 6, '#ffffff').set(11, 11, '#ffd35c');
  sprites[name] = s;
}

sprites.path = (() => {
  const s = new Sprite(16, 16).rect(0, 0, 16, 16, '#c9bc9d');
  for (const [x, y, w, h] of [[0, 0, 7, 5], [8, 0, 8, 6], [0, 6, 5, 5], [6, 7, 10, 4], [0, 12, 9, 4], [10, 12, 6, 4]]) {
    s.rect(x + 1, y + 1, w - 1, h - 1, '#ddd2b8');
    s.rect(x + 1, y + 1, w - 2, 1, '#e9e0ca');
  }
  return s;
})();

sprites.wall = new Sprite(16, 16).rect(0, 0, 16, 16, '#4a4f5e').rect(0, 0, 16, 2, '#6b7183').rect(0, 15, 16, 1, '#353946');

sprites.rug = (() => {
  const s = new Sprite(64, 40).box(0, 0, 64, 40, '#c95f5f', '#8f3b3b');
  s.rect(3, 3, 58, 34, '#e7c27a').rect(5, 5, 54, 30, '#c95f5f');
  for (let x = 9; x < 56; x += 8) s.rect(x, 18, 4, 4, '#e7c27a');
  return s;
})();

// ---------------------------------------------------------------------------
// Móveis
// ---------------------------------------------------------------------------

sprites.desk = (() => {
  const s = new Sprite(48, 28);
  s.box(0, 0, 48, 20, 'b'); // tampo
  s.rect(1, 1, 46, 2, '#e6bd88');
  s.box(0, 18, 48, 6, 'B'); // frente
  s.rect(1, 22, 46, 1, 'n');
  s.box(2, 23, 4, 5, 'n').box(42, 23, 4, 5, 'n'); // pernas
  s.box(30, 19, 12, 5, 'B').rect(35, 21, 2, 1, 'y'); // gaveta
  return s;
})();

for (const [name, screen, line] of [
  ['monitor_off', 's', 'S'],
  ['monitor_on', 'c', 'C'],
  ['monitor_wait', 'o', 'O'],
]) {
  const s = new Sprite(22, 18);
  s.box(0, 0, 22, 14, 'd');
  s.rect(2, 2, 18, 10, screen);
  if (name !== 'monitor_off') {
    // "linhas de código" na tela
    for (const [x, y, w] of [[3, 3, 8], [5, 5, 10], [5, 7, 6], [3, 9, 9]]) s.rect(x, y, w, 1, line);
  } else {
    s.rect(3, 3, 4, 1, '#4a5366');
  }
  s.box(9, 13, 4, 3, 'G').box(5, 15, 12, 3, 'G');
  sprites[name] = s;
}

sprites.keyboard = new Sprite(16, 5).box(0, 0, 16, 5, 'g').rect(2, 2, 12, 1, 'G');
sprites.mug = new Sprite(6, 6).box(0, 1, 5, 5, 'w').set(5, 3, 'k').set(1, 0, 'G').set(3, 0, 'G');

sprites.chair = (() => {
  const s = new Sprite(18, 22);
  s.box(2, 0, 14, 11, 'r'); // assento
  s.rect(3, 1, 12, 2, '#f08a8a');
  s.box(0, 9, 18, 9, 'r'); // encosto (fica na frente de quem senta)
  s.rect(1, 10, 16, 2, '#f08a8a');
  s.rect(1, 15, 16, 2, 'R');
  s.box(7, 17, 4, 3, 'd'); // base
  s.box(2, 19, 14, 3, 'd');
  return s;
})();

sprites.plant = (() => {
  const s = new Sprite(18, 26);
  s.ellipse(9, 7, 7, 6, 'L').ellipse(6, 9, 4, 4, 'L').ellipse(12, 10, 4, 3, 'L');
  s.ellipse(7, 5, 3, 2, 'l').ellipse(12, 7, 2, 2, 'l');
  s.set(9, 11, 'm').set(5, 12, 'm').set(13, 12, 'm');
  s.outline();
  s.box(3, 15, 12, 11, 'p');
  s.rect(3, 15, 12, 3, 'P').box(2, 15, 14, 3, 'p');
  s.rect(4, 19, 2, 5, '#e08a5c');
  return s;
})();

sprites.plant_tall = (() => {
  const s = new Sprite(18, 34);
  for (const [cx, cy] of [[9, 4], [5, 9], [13, 9], [9, 13], [5, 17], [13, 17]]) s.ellipse(cx, cy, 4, 3, 'L');
  for (const [cx, cy] of [[8, 3], [4, 8], [12, 8], [8, 12]]) s.ellipse(cx, cy, 2, 1, 'l');
  s.rect(8, 6, 2, 16, 'm');
  s.outline();
  s.box(4, 23, 10, 11, 'g').rect(5, 24, 8, 2, 'W');
  return s;
})();

sprites.tree = (() => {
  const s = new Sprite(40, 50);
  s.ellipse(20, 17, 17, 15, 'L');
  s.ellipse(14, 12, 8, 6, 'l').ellipse(26, 20, 6, 5, '#5cb84a');
  for (let i = 0; i < 18; i++) s.set(6 + Math.floor(rand() * 28), 6 + Math.floor(rand() * 22), 'm');
  s.outline();
  s.box(16, 30, 8, 18, 'n').rect(17, 31, 2, 16, 'B');
  s.ellipse(20, 48, 10, 2, '#5aa148');
  return s;
})();

sprites.bush = (() => {
  const s = new Sprite(20, 14);
  s.ellipse(10, 8, 9, 5, 'L').ellipse(6, 6, 4, 3, 'l').ellipse(14, 7, 3, 3, 'l');
  s.set(4, 3, '#ff7f9e').set(13, 4, '#ffd35c').set(9, 9, '#ff7f9e');
  return s.outline();
})();

sprites.bookshelf = (() => {
  const s = new Sprite(34, 36);
  s.box(0, 0, 34, 36, 'B');
  s.rect(1, 1, 32, 2, 'b');
  const colors = ['r', 'u', 'y', 'L', 'v', 't', 'o', 'W'];
  for (let shelf = 0; shelf < 3; shelf++) {
    const y0 = 4 + shelf * 11;
    s.rect(2, y0, 30, 9, 'n');
    let x = 3;
    while (x < 30) {
      const w = 2 + Math.floor(rand() * 2);
      const h = 6 + Math.floor(rand() * 3);
      s.rect(x, y0 + 9 - h, w, h, colors[Math.floor(rand() * colors.length)]);
      x += w + (rand() < 0.2 ? 2 : 0);
    }
    s.rect(1, y0 + 9, 32, 2, 'B');
  }
  return s;
})();

sprites.whiteboard = (() => {
  const s = new Sprite(50, 26);
  s.box(0, 0, 50, 22, 'G');
  s.rect(2, 2, 46, 18, 'w');
  s.rect(5, 5, 20, 1, 'u').rect(5, 8, 30, 1, 'r').rect(5, 11, 14, 1, 'L');
  s.box(30, 10, 14, 8, 'w').rect(32, 14, 3, 3, 'o').rect(36, 12, 3, 5, 'u').rect(40, 15, 2, 2, 'L');
  s.rect(6, 20, 38, 2, 'g').set(10, 21, 'r').set(13, 21, 'u');
  s.rect(4, 22, 2, 4, 'G').rect(44, 22, 2, 4, 'G');
  return s;
})();

sprites.sofa = (() => {
  const s = new Sprite(84, 32);
  s.box(0, 0, 84, 16, 'U'); // encosto
  s.rect(1, 1, 82, 3, 'u');
  s.box(0, 10, 84, 20, 'u'); // assento
  s.box(4, 12, 38, 12, 'u').box(42, 12, 38, 12, 'u');
  s.rect(5, 13, 36, 2, '#86b0ea').rect(43, 13, 36, 2, '#86b0ea');
  s.box(0, 6, 8, 24, 'U').box(76, 6, 8, 24, 'U'); // braços
  s.rect(1, 7, 6, 2, 'u').rect(77, 7, 6, 2, 'u');
  s.rect(2, 29, 80, 3, 'n');
  return s;
})();

sprites.armchair = (() => {
  const s = new Sprite(26, 28);
  s.box(0, 0, 26, 12, 'U').box(0, 8, 26, 18, 'u').box(4, 10, 18, 12, 'u');
  s.rect(5, 11, 16, 2, '#86b0ea');
  s.box(0, 5, 6, 21, 'U').box(20, 5, 6, 21, 'U');
  s.rect(2, 25, 22, 3, 'n');
  return s;
})();

sprites.coffee_table = (() => {
  const s = new Sprite(44, 22);
  s.box(0, 0, 44, 14, 'n').rect(1, 1, 42, 2, 'B');
  s.box(0, 12, 44, 5, 'n');
  s.box(2, 16, 4, 6, 'n').box(38, 16, 4, 6, 'n');
  s.box(8, 4, 12, 7, 'W').rect(10, 6, 8, 1, 'G'); // revista
  s.box(28, 4, 5, 5, 'w').set(33, 6, 'k'); // xícara
  return s;
})();

sprites.counter = (() => {
  const s = new Sprite(56, 30);
  s.box(0, 0, 56, 12, 'W').rect(1, 1, 54, 2, 'w');
  s.box(0, 10, 56, 20, 'B');
  s.box(3, 13, 24, 15, 'b').box(29, 13, 24, 15, 'b');
  s.rect(13, 19, 4, 1, 'n').rect(39, 19, 4, 1, 'n');
  return s;
})();

sprites.coffee_machine = (() => {
  const s = new Sprite(18, 24);
  s.box(0, 0, 18, 24, 'd');
  s.rect(1, 1, 16, 3, 'G');
  s.box(3, 5, 12, 6, 'S').rect(5, 7, 3, 1, 'c').set(12, 7, 'r');
  s.box(5, 13, 8, 8, 'S');
  s.box(6, 15, 6, 6, 'w').rect(7, 16, 4, 1, 'n');
  return s;
})();

sprites.cups = (() => {
  const s = new Sprite(16, 8);
  for (const x of [0, 5, 10]) s.box(x, 2, 5, 6, 'w').rect(x + 1, 3, 3, 1, 'r');
  return s;
})();

sprites.water_cooler = (() => {
  const s = new Sprite(16, 36);
  s.box(2, 0, 12, 14, '#9fdcff').rect(3, 1, 4, 10, '#d9f3ff').rect(3, 12, 10, 1, '#5fb6e8');
  s.box(0, 13, 16, 23, 'W').rect(1, 14, 14, 2, 'w');
  s.box(3, 18, 4, 3, 'u').box(9, 18, 4, 3, 'r');
  s.rect(2, 32, 12, 2, 'g');
  return s;
})();

sprites.umbrella = (() => {
  const s = new Sprite(44, 46);
  s.ellipse(22, 40, 14, 4, '#5aa148'); // sombra
  s.box(20, 16, 4, 26, 'G');
  s.box(10, 30, 24, 10, 'b').rect(11, 31, 22, 2, '#e6bd88');
  // Gomos alternados vermelho/branco
  for (let y = 0; y <= 26; y++) {
    for (let x = 0; x <= 44; x++) {
      if (((x - 22) / 20) ** 2 + ((y - 13) / 12) ** 2 > 1) continue;
      const sector = Math.floor(((Math.atan2((y - 13) / 0.6, x - 22) + Math.PI) / (2 * Math.PI)) * 8);
      s.set(x, y, sector % 2 ? 'r' : 'w');
    }
  }
  s.ellipse(22, 13, 2, 2, 'y');
  return s.outline();
})();

sprites.bench = (() => {
  const s = new Sprite(50, 18);
  s.box(0, 0, 50, 5, 'b').box(0, 5, 50, 5, 'b').box(0, 10, 50, 4, 'B');
  s.rect(1, 1, 48, 1, '#e6bd88').rect(1, 6, 48, 1, '#e6bd88');
  s.box(3, 13, 4, 5, 'd').box(43, 13, 4, 5, 'd');
  return s;
})();

sprites.lamp = (() => {
  const s = new Sprite(12, 44);
  s.box(1, 0, 10, 8, 'W').rect(2, 6, 8, 1, 'y');
  s.box(4, 7, 4, 33, 'd');
  s.box(1, 38, 10, 6, 'd');
  return s;
})();

sprites.bin = new Sprite(12, 14).box(0, 2, 12, 12, 'G').rect(1, 3, 10, 2, 'g').box(0, 0, 12, 4, 'd');
sprites.clock = (() => {
  const s = new Sprite(16, 16).ellipse(7.5, 7.5, 7.5, 7.5, 'k').ellipse(7.5, 7.5, 6.3, 6.3, 'w');
  s.rect(7, 3, 1, 5, 'k').rect(7, 7, 4, 1, 'k').set(7, 7, 'r');
  return s;
})();
sprites.cabinet = (() => {
  const s = new Sprite(18, 30).box(0, 0, 18, 30, 'g');
  for (const y of [2, 11, 20]) s.box(2, y, 14, 8, 'W').rect(7, y + 3, 4, 1, 'G');
  return s;
})();

for (const [name, light, dark] of [['pouf_yellow', 'y', 'Y'], ['pouf_red', 'r', 'R'], ['pouf_blue', 'u', 'U']]) {
  const s = new Sprite(18, 16);
  s.ellipse(9, 9, 8.5, 6.5, dark).ellipse(9, 7, 7.5, 5.5, light).ellipse(7, 5, 3, 1.5, 'w');
  sprites[name] = s.outline();
}

sprites.printer = (() => {
  const s = new Sprite(26, 20);
  s.box(0, 4, 26, 16, 'g').rect(1, 5, 24, 2, 'W');
  s.box(5, 0, 16, 6, 'w').box(4, 12, 18, 4, 'd').set(21, 8, 'L');
  return s;
})();

// ---------------------------------------------------------------------------
// Personagens (16x24). Cores h/f/x/q são trocadas pelas da persona.
// ---------------------------------------------------------------------------

const HEAD_DOWN = [
  '................',
  '.....kkkkkk.....',
  '....khhhhhhk....',
  '...khhhhhhhhk...',
  '...khhhhhhhhk...',
  '...khHffffHhk...',
  '...kfffffffFk...',
  '...kfefffefFk...',
  '...kffffffFFk...',
  '....kFFFFFFk....',
];
const HEAD_UP = [
  '................',
  '.....kkkkkk.....',
  '....khhhhhhk....',
  '...khhhhhhhhk...',
  '...khhhhhhhhk...',
  '...khhhhhhhhk...',
  '...khhhhhhhhk...',
  '...kHhhhhhhHk...',
  '...kHHHHHHHHk...',
  '....kFFFFFFk....',
];
const HEAD_SIDE = [
  '................',
  '.....kkkkkk.....',
  '....khhhhhhk....',
  '...khhhhhhhhk...',
  '...khhhhhhhhk...',
  '...khhhhhfffk...',
  '...khhhhffffk...',
  '...kHhhhfffek...',
  '...kHHhhffffk...',
  '....kFFFFFFk....',
];
const BODY_FRONT = [
  '...kxxxxxxxxk...',
  '..kxxxxxxxxxxk..',
  '..kxkxxxxxxkxk..',
  '..kxkxxxxxxkxk..',
  '..kXkXxxxxXkXk..',
  '..kfkXXXXXXkfk..',
];
const BODY_SIDE = [
  '....kxxxxxxk....',
  '...kxxxxxxxxk...',
  '...kxxxXXxxxk...',
  '...kxxxXXxxxk...',
  '...kXxxXXxxXk...',
  '...kXXXffXXXk...',
];
const HIPS = ['....kqqqqqqk....', '....kqqqqqqk....', '....kqqQQqqk....', '....kqqkkqqk....'];
const LEGS = {
  idle: ['....kQQkkQQk....', '....kzzkkzzk....', '....kkkkkkkk....', '................'],
  a: ['....kQQkkzzk....', '....kzzk.kkk....', '....kkkk........', '................'],
  b: ['....kzzkkQQk....', '....kkk.kzzk....', '........kkkk....', '................'],
};
const EMPTY = (n) => Array(n).fill('................');

const FRAMES = [
  ['down', HEAD_DOWN, BODY_FRONT, 'idle'],
  ['down', HEAD_DOWN, BODY_FRONT, 'a'],
  ['down', HEAD_DOWN, BODY_FRONT, 'b'],
  ['up', HEAD_UP, BODY_FRONT, 'idle'],
  ['up', HEAD_UP, BODY_FRONT, 'a'],
  ['up', HEAD_UP, BODY_FRONT, 'b'],
  ['side', HEAD_SIDE, BODY_SIDE, 'idle'],
  ['side', HEAD_SIDE, BODY_SIDE, 'a'],
  ['side', HEAD_SIDE, BODY_SIDE, 'b'],
];

function character(head, body, legs) {
  return [...head, ...body, ...HIPS, ...LEGS[legs]];
}

// Sentado de costas (na mesa) e sentado de frente (no sofá).
const SIT_BACK = [...HEAD_UP, ...BODY_FRONT, '....kqqqqqqk....', '....kkkkkkkk....', ...EMPTY(6)];
const SIT_FRONT = [
  ...EMPTY(2),
  ...HEAD_DOWN,
  ...BODY_FRONT,
  '...kqqqqqqqqk...',
  '...kQQQQQQQQk...',
  '....kzzkkzzk....',
  '....kkkkkkkk....',
];

// Variação de cabelo comprido: o cabelo desce pelos lados até os ombros.
function longHair(rows, view) {
  const out = rows.map((r) => [...r]);
  const top = rows[0] === '................' && rows[1] === '................' ? 2 : 0;
  for (let y = top + 6; y <= top + 11; y++) {
    if (view === 'side') {
      out[y][3] = 'k';
      out[y][4] = y > top + 9 ? 'H' : 'h';
    } else {
      out[y][2] = 'k';
      out[y][3] = 'h';
      out[y][12] = 'h';
      out[y][13] = 'k';
    }
  }
  if (view === 'up') {
    for (let x = 4; x <= 11; x++) out[top + 9][x] = 'H';
  }
  return out.map((r) => r.join(''));
}

const frameRows = [
  ...FRAMES.map(([, head, body, legs]) => character(head, body, legs)),
  SIT_BACK,
  SIT_FRONT,
];
const frameViews = [...FRAMES.map(([view]) => view), 'up', 'down'];

const chars = new Sprite(16 * frameRows.length, 24 * 2);
frameRows.forEach((rows, i) => {
  chars.blit(new Sprite(16, 24).map(rows), i * 16, 0);
  chars.blit(new Sprite(16, 24).map(longHair(rows, frameViews[i])), i * 16, 24);
});

// ---------------------------------------------------------------------------
// Empacotamento do atlas e PNG
// ---------------------------------------------------------------------------

function pack(entries, width) {
  let x = 0;
  let y = 0;
  let rowH = 0;
  const frames = {};
  // Maiores primeiro, para aproveitar melhor o espaço.
  for (const [name, s] of [...entries].sort((a, b) => b[1].h - a[1].h)) {
    if (x + s.w > width) {
      x = 0;
      y += rowH + 2;
      rowH = 0;
    }
    frames[name] = { x, y, s };
    x += s.w + 2; // 2 px de folga evitam "sangrar" pixels vizinhos
    rowH = Math.max(rowH, s.h);
  }
  const sheet = new Sprite(width, y + rowH);
  for (const f of Object.values(frames)) sheet.blit(f.s, f.x, f.y);
  return { sheet, frames };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(sprite) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(sprite.w, 0);
  ihdr.writeUInt32BE(sprite.h, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((sprite.w * 4 + 1) * sprite.h);
  for (let y = 0; y < sprite.h; y++) {
    raw[y * (sprite.w * 4 + 1)] = 0; // sem filtro
    Buffer.from(sprite.px.buffer, y * sprite.w * 4, sprite.w * 4).copy(raw, y * (sprite.w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });

const { sheet, frames } = pack(Object.entries(sprites), 256);
writeFileSync(join(OUT, 'office.png'), png(sheet));
writeFileSync(
  join(OUT, 'office.json'),
  JSON.stringify(
    {
      frames: Object.fromEntries(
        Object.entries(frames).map(([name, f]) => [
          name,
          {
            frame: { x: f.x, y: f.y, w: f.s.w, h: f.s.h },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: f.s.w, h: f.s.h },
            sourceSize: { w: f.s.w, h: f.s.h },
          },
        ]),
      ),
      meta: { image: 'office.png', size: { w: sheet.w, h: sheet.h }, scale: '1' },
    },
    null,
    1,
  ) + '\n',
);
writeFileSync(join(OUT, 'chars.png'), png(chars));

console.log(`office.png: ${Object.keys(frames).length} sprites (${sheet.w}x${sheet.h})`);
console.log(`chars.png: ${frameRows.length} quadros x 2 estilos de cabelo`);
