// Escritório virtual em Phaser: desenha o mapa (gerado por código, sem
// assets externos), cria um personagem por agente e move cada um de acordo
// com o estado que chega do servidor via WebSocket.

/* global Phaser */

const T = 32; // tamanho de um "tile"
const ROOM_W = 14; // sala em tiles
const ROOM_H = 10;
const HALL_H = 7; // corredor principal (com café, sofá...) no topo
const CORR_H = 2; // corredor acima de cada fileira extra de salas
const COLS = 3; // salas por fileira
const GARDEN_W = 7; // jardim à direita, também serve de passagem vertical
const SPEED = 130; // px por segundo
const DESKS_PER_ROOM = 6;

const C = {
  hall: [0xf1efe9, 0xe8e6df],
  room: [0xece4d2, 0xe3dac6],
  wall: 0x3d4250,
  grass: [0x7cc36a, 0x72ba60],
  path: 0xd8ccb0,
  desk: 0xb07d4f,
  deskTop: 0xcfa271,
  chair: 0xb5443c,
  screenOff: 0x2b2f3a,
  screenOn: 0x5ec8ff,
  screenWait: 0xffb74d,
  pot: 0xc0643b,
  leaf: [0x3f9a4a, 0x5cb85c],
  sofa: 0x4a6fb5,
  wood: 0x8a5a33,
  books: [0xe57373, 0x64b5f6, 0xffd54f, 0x81c784, 0xba68c8],
};

const STATUS_COLOR = { working: '#4fc3f7', waiting: '#ffb74d', idle: '#9e9e9e' };

// ---------------------------------------------------------------------------
// Layout: onde fica cada sala, mesa e ponto de encontro
// ---------------------------------------------------------------------------

class Layout {
  constructor(projects) {
    this.projects = projects;
    this.rows = Math.max(1, Math.ceil(projects.length / COLS));
    this.hallW = COLS * ROOM_W * T;
    this.width = this.hallW + GARDEN_W * T;
    this.height = this.rowTop(this.rows - 1) + ROOM_H * T + T;
    this.gardenX = this.hallW + 1.5 * T; // trilha vertical do jardim
  }

  rowTop(r) {
    return HALL_H * T + r * (ROOM_H + CORR_H) * T;
  }

  corridorY(r) {
    return this.rowTop(r) - T;
  }

  room(project) {
    const i = this.projects.indexOf(project);
    if (i < 0) return null;
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    return { r, c, x: c * ROOM_W * T, y: this.rowTop(r), doorX: c * ROOM_W * T + 7 * T };
  }

  desk(room, i) {
    if (i >= DESKS_PER_ROOM) {
      // Sem mesa livre: fica em pé perto do quadro.
      const k = i - DESKS_PER_ROOM;
      return { x: room.x + (10 + (k % 3)) * T, y: room.y + 2 * T, laneX: room.x + 9 * T, overflow: true };
    }
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = room.x + (1.5 + col * 4) * T;
    const y = room.y + (2.8 + row * 3.6) * T;
    return { deskX: x, deskY: y, x: x + 1.5 * T, y: y + 2.3 * T, laneX: room.x + (1 + col * 4) * T };
  }

  spot(name, slot = 0) {
    const s = slot % 4;
    switch (name) {
      case 'cafe': return { x: (1.6 + s * 1.6) * T, y: 2.8 * T };
      case 'bebedouro': return { x: (7.6 + s * 1.6) * T, y: 2.8 * T };
      case 'sofa': return { x: (15.6 + s * 1.6) * T, y: 2.6 * T };
      case 'estante': return { x: (25.6 + s * 1.6) * T, y: 2.8 * T };
      case 'jardim': return { x: this.hallW + (2.6 + s * 1.6) * T, y: 4.5 * T };
      default: return { x: 2 * T, y: 2.8 * T };
    }
  }

  spawn() {
    return { x: T, y: this.corridorY(0) };
  }

  // Posição final de um "lugar" (mesa, ponto de encontro, entrada).
  locPos(loc, agent) {
    if (loc.kind === 'spot') return this.spot(loc.spot, loc.slot);
    if (loc.kind === 'desk') {
      const room = this.room(agent.project);
      return room ? this.desk(room, agent.deskIndex) : this.spawn();
    }
    return this.spawn();
  }

  // Caminho de saída de um lugar até o corredor (ou trilha do jardim).
  exitOf(loc, agent, pos) {
    if (loc.kind === 'desk') {
      const room = this.room(agent.project);
      if (room) {
        const d = this.desk(room, agent.deskIndex);
        const aisle = room.y + 1.6 * T;
        return {
          row: room.r,
          pts: [
            { x: d.laneX, y: pos.y },
            { x: d.laneX, y: aisle },
            { x: room.doorX, y: aisle },
            { x: room.doorX, y: this.corridorY(room.r) },
          ],
        };
      }
    }
    if (loc.kind === 'spot' && loc.spot === 'jardim') {
      return { row: 'garden', pts: [{ x: this.gardenX, y: pos.y }] };
    }
    return { row: 0, pts: [{ x: pos.x, y: this.corridorY(0) }] };
  }

  // Caminho do corredor até o lugar (ordem: do corredor para dentro).
  entryOf(loc, agent) {
    const target = this.locPos(loc, agent);
    if (loc.kind === 'desk') {
      const room = this.room(agent.project);
      if (room) {
        const d = this.desk(room, agent.deskIndex);
        const aisle = room.y + 1.6 * T;
        return {
          row: room.r,
          pts: [
            { x: room.doorX, y: this.corridorY(room.r) },
            { x: room.doorX, y: aisle },
            { x: d.laneX, y: aisle },
            { x: d.laneX, y: target.y },
            target,
          ],
        };
      }
    }
    if (loc.kind === 'spot' && loc.spot === 'jardim') {
      return { row: 'garden', pts: [{ x: this.gardenX, y: target.y }, target] };
    }
    return { row: 0, pts: [{ x: target.x, y: this.corridorY(0) }, target] };
  }

  path(fromLoc, agent, pos, toLoc) {
    const exit = this.exitOf(fromLoc, agent, pos);
    const entry = this.entryOf(toLoc, agent);
    const pts = [...exit.pts];
    if (exit.row !== entry.row) {
      // Troca de fileira passando pela trilha do jardim.
      if (exit.row !== 'garden') pts.push({ x: this.gardenX, y: this.corridorY(exit.row) });
      if (entry.row !== 'garden') pts.push({ x: this.gardenX, y: this.corridorY(entry.row) });
    }
    pts.push(...entry.pts);
    return pts;
  }
}

// ---------------------------------------------------------------------------
// Sprites gerados por código
// ---------------------------------------------------------------------------

const hex = (s) => parseInt(s.replace('#', ''), 16);

// Personagem de 12x18 "pixels", cada pixel com 2px de lado.
function makeCharacterTextures(scene, persona) {
  const front = `char-${persona.id}`;
  if (scene.textures.exists(front)) return front;
  const P = 2;
  const skin = hex(persona.pele);
  const hair = hex(persona.cabelo);
  const shirt = hex(persona.camisa);
  const pants = hex(persona.calca);

  for (const side of ['front', 'back']) {
    const g = scene.make.graphics({ add: false });
    const px = (x, y, w, h, color) => {
      g.fillStyle(color, 1);
      g.fillRect(x * P, y * P, w * P, h * P);
    };
    px(3, 2, 6, 5, skin); // rosto
    px(3, 0, 6, 2, hair); // cabelo
    if (side === 'front') {
      px(2, 1, 1, 3, hair);
      px(9, 1, 1, 3, hair);
      px(4, 4, 1, 1, 0x222222); // olhos
      px(7, 4, 1, 1, 0x222222);
    } else {
      px(2, 1, 8, 5, hair);
    }
    px(2, 7, 8, 6, shirt); // tronco
    px(1, 8, 1, 3, shirt); // braços
    px(10, 8, 1, 3, shirt);
    px(1, 11, 1, 1, skin); // mãos
    px(10, 11, 1, 1, skin);
    px(3, 13, 6, 2, pants); // pernas
    px(3, 15, 2, 2, pants);
    px(7, 15, 2, 2, pants);
    px(3, 17, 2, 1, 0x333333); // sapatos
    px(7, 17, 2, 1, 0x333333);
    g.generateTexture(side === 'front' ? front : `${front}-back`, 12 * P, 18 * P);
    g.destroy();
  }
  return front;
}

// ---------------------------------------------------------------------------
// Cena
// ---------------------------------------------------------------------------

class OfficeScene extends Phaser.Scene {
  constructor() {
    super('office');
    this.views = new Map();
    this.monitors = new Map();
    this.hangouts = new Map();
    this.layout = null;
    this.worldLayer = null;
  }

  create() {
    this.cameras.main.setBackgroundColor('#1e2129');
    this.setupCameraControls();
    this.scale.on('resize', () => this.fitCamera());
    this.connect();
  }

  // --- conexão --------------------------------------------------------------

  connect() {
    const conn = document.getElementById('conn');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      conn.textContent = 'conectado';
      conn.className = 'conn on';
    };
    ws.onclose = () => {
      conn.textContent = 'desconectado';
      conn.className = 'conn off';
      setTimeout(() => this.connect(), 2000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') this.onState(msg);
      else if (msg.type === 'wander') this.onWander(msg);
      else if (msg.type === 'hangout') this.onHangout(msg);
      else if (msg.type === 'chat') this.onChat(msg);
    };
  }

  // --- câmera ---------------------------------------------------------------

  setupCameraControls() {
    const cam = this.cameras.main;
    this.input.on('pointermove', (p) => {
      if (!p.isDown) return;
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
      this.userMovedCamera = true;
    });
    this.input.on('wheel', (_p, _o, _dx, dy) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.3, 3));
      this.userMovedCamera = true;
    });
  }

  fitCamera() {
    if (!this.layout || this.userMovedCamera) return;
    const cam = this.cameras.main;
    const hudH = document.getElementById('hud').offsetHeight;
    const w = this.scale.width;
    const h = this.scale.height - hudH;
    const zoom = Phaser.Math.Clamp(Math.min(w / this.layout.width, h / this.layout.height) * 0.97, 0.3, 2);
    cam.setZoom(zoom);
    cam.centerOn(this.layout.width / 2, this.layout.height / 2 - hudH / 2 / zoom);
  }

  // --- desenho do mapa ------------------------------------------------------

  drawWorld() {
    this.worldLayer?.destroy();
    this.monitors.clear();
    const L = this.layout;
    const layer = this.add.container(0, 0);
    this.worldLayer = layer;
    const g = this.add.graphics();
    layer.add(g);

    const checker = (x0, y0, w, h, colors) => {
      for (let y = 0; y < h; y += T) {
        for (let x = 0; x < w; x += T) {
          g.fillStyle(colors[((x + y) / T) % 2], 1);
          g.fillRect(x0 + x, y0 + y, Math.min(T, w - x), Math.min(T, h - y));
        }
      }
    };

    // Corredor principal + corredores entre fileiras
    checker(0, 0, L.hallW, HALL_H * T, C.hall);
    for (let r = 1; r < L.rows; r++) checker(0, L.rowTop(r) - CORR_H * T, L.hallW, CORR_H * T, C.hall);
    g.fillStyle(C.wall, 1);
    g.fillRect(0, 0, L.hallW, 6);

    // Jardim
    checker(L.hallW, 0, GARDEN_W * T, L.height, C.grass);
    g.fillStyle(C.path, 1);
    g.fillRect(L.gardenX - T * 0.5, 0, T, L.height);
    this.drawTree(g, L.hallW + 5.5 * T, 2.2 * T);
    this.drawUmbrella(g, L.hallW + 4.6 * T, 3.6 * T);
    for (let y = 9; y < L.height / T - 1; y += 5) this.drawTree(g, L.hallW + 4.5 * T + ((y * 7) % 3) * T, y * T);

    // Pontos de encontro do corredor
    this.drawCoffee(g, 2 * T, 0.4 * T);
    this.drawWaterCooler(g, 8 * T, 0.4 * T);
    this.drawSofa(g, 15 * T, 0.6 * T);
    this.drawBookshelf(g, 25.4 * T, 0.2 * T);
    [5, 12, 21, 31, 37].forEach((x) => this.drawPlant(g, x * T, 1.2 * T));
    this.addLabel(layer, 2.9 * T, 1.75 * T, 'café');
    this.addLabel(layer, 8 * T, 1.75 * T, 'bebedouro');
    this.addLabel(layer, 26.5 * T, 1.75 * T, 'estante');
    this.addLabel(layer, L.hallW + 4.5 * T, 5.4 * T, 'jardim');

    // Salas
    for (const project of L.projects) this.drawRoom(g, layer, L.room(project), project);

    layer.setDepth(0);
    this.fitCamera();
  }

  drawRoom(g, layer, room, project) {
    const w = ROOM_W * T;
    const h = ROOM_H * T;
    g.fillStyle(C.room[0], 1);
    g.fillRect(room.x, room.y, w, h);
    g.fillStyle(C.room[1], 1);
    for (let y = 0; y < h; y += T * 2) g.fillRect(room.x, room.y + y, w, T);

    // Paredes, com porta no meio da parede de cima
    const t = 6;
    g.fillStyle(C.wall, 1);
    g.fillRect(room.x, room.y, room.doorX - T - room.x, t);
    g.fillRect(room.doorX + T, room.y, room.x + w - room.doorX - T, t);
    g.fillRect(room.x, room.y + h - t, w, t);
    g.fillRect(room.x, room.y, t, h);
    g.fillRect(room.x + w - t, room.y, t, h);

    // Decoração
    this.drawBookshelf(g, room.x + 0.5 * T, room.y + 0.3 * T);
    this.drawWhiteboard(g, room.x + 10 * T, room.y + 0.3 * T);
    this.drawPlant(g, room.x + 12.8 * T, room.y + 8.6 * T);
    this.drawPlant(g, room.x + 0.8 * T, room.y + 8.6 * T);

    // Mesas
    for (let i = 0; i < DESKS_PER_ROOM; i++) {
      const d = this.layout.desk(room, i);
      g.fillStyle(C.desk, 1);
      g.fillRect(d.deskX, d.deskY, 3 * T, 1.3 * T);
      g.fillStyle(C.deskTop, 1);
      g.fillRect(d.deskX + 3, d.deskY + 3, 3 * T - 6, 1.3 * T - 10);
      g.fillStyle(C.chair, 1);
      g.fillRoundedRect(d.x - 0.4 * T, d.y - 0.75 * T, 0.8 * T, 0.7 * T, 4);
      const frame = this.add.rectangle(d.deskX + 1.5 * T, d.deskY + 0.45 * T, 1.3 * T, 0.75 * T, 0x1b1d23);
      const screen = this.add.rectangle(d.deskX + 1.5 * T, d.deskY + 0.45 * T, 1.3 * T - 6, 0.75 * T - 6, C.screenOff);
      layer.add([frame, screen]);
      this.monitors.set(`${project}:${i}`, screen);
    }

    // Placa com o nome do projeto, acima da porta
    const sign = this.add
      .text(room.doorX - 1.3 * T, room.y - 4, project, {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#2b2f3a',
        backgroundColor: '#fffdf5',
        padding: { x: 6, y: 2 },
        resolution: 2,
      })
      .setOrigin(1, 1);
    layer.add(sign);
  }

  addLabel(layer, x, y, text) {
    layer.add(
      this.add
        .text(x, y, text, { fontSize: '10px', color: '#8a867a', resolution: 2 })
        .setOrigin(0.5, 0),
    );
  }

  drawPlant(g, x, y) {
    g.fillStyle(C.pot, 1);
    g.fillRect(x - 8, y + 6, 16, 12);
    g.fillStyle(C.leaf[0], 1);
    g.fillCircle(x, y - 2, 11);
    g.fillStyle(C.leaf[1], 1);
    g.fillCircle(x - 5, y - 6, 6);
    g.fillCircle(x + 6, y + 1, 5);
  }

  drawTree(g, x, y) {
    g.fillStyle(0x7a4f2c, 1);
    g.fillRect(x - 5, y, 10, 22);
    g.fillStyle(0x3f8f3a, 1);
    g.fillCircle(x, y - 6, 22);
    g.fillStyle(0x58a84f, 1);
    g.fillCircle(x - 8, y - 12, 11);
  }

  drawUmbrella(g, x, y) {
    g.fillStyle(0xc9a26b, 1);
    g.fillRect(x - 2.5 * T, y - 0.4 * T, 2.4 * T, 1.6 * T);
    g.fillStyle(0xe53935, 1);
    g.fillCircle(x - 1.3 * T, y - 0.2 * T, 16);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(x - 1.3 * T, y - 0.2 * T, 6);
  }

  drawCoffee(g, x, y) {
    g.fillStyle(C.wood, 1);
    g.fillRect(x - 6, y + 10, 2 * T, 0.9 * T);
    g.fillStyle(0x37474f, 1);
    g.fillRect(x + 4, y, 20, 22);
    g.fillStyle(0xd84315, 1);
    g.fillRect(x + 8, y + 4, 12, 5);
    g.fillStyle(0xffffff, 1);
    g.fillRect(x + 32, y + 14, 8, 8);
  }

  drawWaterCooler(g, x, y) {
    g.fillStyle(0xeceff1, 1);
    g.fillRect(x - 10, y + 12, 20, 28);
    g.fillStyle(0x4fc3f7, 1);
    g.fillRoundedRect(x - 8, y - 4, 16, 18, 4);
  }

  drawSofa(g, x, y) {
    g.fillStyle(C.sofa, 1);
    g.fillRoundedRect(x, y, 5 * T, 0.8 * T, 6);
    g.fillRoundedRect(x - 0.3 * T, y + 0.2 * T, 0.6 * T, 1.2 * T, 6);
    g.fillRoundedRect(x + 4.7 * T, y + 0.2 * T, 0.6 * T, 1.2 * T, 6);
    g.fillStyle(0x5d83c9, 1);
    g.fillRoundedRect(x + 0.3 * T, y + 0.6 * T, 4.4 * T, 0.7 * T, 4);
    g.fillStyle(0x6d4c41, 1);
    g.fillRect(x + 1.2 * T, y + 2.6 * T, 2.6 * T, 0.8 * T);
  }

  drawBookshelf(g, x, y) {
    g.fillStyle(C.wood, 1);
    g.fillRect(x, y, 2.2 * T, 1.1 * T);
    for (let shelf = 0; shelf < 2; shelf++) {
      for (let b = 0; b < 8; b++) {
        g.fillStyle(C.books[(b + shelf * 3) % C.books.length], 1);
        g.fillRect(x + 4 + b * 8, y + 4 + shelf * 15, 6, 12);
      }
    }
  }

  drawWhiteboard(g, x, y) {
    g.fillStyle(0x90a4ae, 1);
    g.fillRect(x, y, 3 * T, 1 * T);
    g.fillStyle(0xffffff, 1);
    g.fillRect(x + 3, y + 3, 3 * T - 6, 1 * T - 6);
    g.lineStyle(2, 0x42a5f5, 1);
    g.lineBetween(x + 10, y + 12, x + 50, y + 12);
    g.lineStyle(2, 0xef5350, 1);
    g.lineBetween(x + 10, y + 20, x + 70, y + 20);
  }

  // --- agentes --------------------------------------------------------------

  createAgent(data) {
    const key = makeCharacterTextures(this, data.persona);
    const start = this.layout.spawn();
    const sprite = this.add.image(0, 0, key).setOrigin(0.5, 1);
    const dot = this.add.circle(0, 0, 4, 0x9e9e9e).setStrokeStyle(1, 0x000000, 0.4);
    const name = this.add
      .text(0, 4, data.nome, {
        fontSize: '11px',
        color: '#ffffff',
        backgroundColor: '#2b2f3acc',
        padding: { x: 5, y: 1 },
        resolution: 2,
      })
      .setOrigin(0.5, 0);
    const bubble = this.add
      .text(0, -42, '', {
        fontSize: '11px',
        color: '#222222',
        backgroundColor: '#ffffff',
        padding: { x: 6, y: 3 },
        align: 'center',
        wordWrap: { width: 3.6 * T },
        resolution: 2,
      })
      .setOrigin(0.5, 1)
      .setVisible(false);
    const container = this.add.container(start.x, start.y, [sprite, name, dot, bubble]);

    const view = {
      data,
      container,
      sprite,
      name,
      dot,
      bubble,
      loc: { kind: 'spawn' },
      moving: false,
      pending: null,
      chatUntil: 0,
    };
    this.views.set(data.id, view);
    container.setDepth(1000 + container.y);
    return view;
  }

  updateLabels(view) {
    const { data } = view;
    view.dot.setFillStyle(hex(STATUS_COLOR[data.status] ?? '#9e9e9e'));
    view.dot.setPosition(-view.name.width / 2 - 6, 4 + view.name.height / 2);
    if (this.time.now < view.chatUntil) return;
    const text = data.status === 'waiting' ? `❗ ${data.activity}` : data.activity;
    view.bubble.setStyle({ backgroundColor: data.status === 'waiting' ? '#ffe0b2' : '#ffffff' });
    view.bubble.setText(text || '').setVisible(Boolean(text));
  }

  say(view, text, ms = 3500) {
    view.chatUntil = this.time.now + ms;
    view.bubble.setStyle({ backgroundColor: '#fff6c2' }).setText(`💬 ${text}`).setVisible(true);
    this.time.delayedCall(ms + 50, () => this.updateLabels(view));
  }

  // Leva o agente até um lugar, andando pelos corredores.
  goTo(view, loc) {
    if (view.moving) {
      view.pending = loc;
      return;
    }
    const pos = { x: view.container.x, y: view.container.y };
    const pts = this.layout.path(view.loc, view.data, pos, loc);
    view.loc = loc;
    view.moving = true;
    this.setSitting(view, false);

    const walk = this.tweens.add({ targets: view.sprite, y: -3, duration: 140, yoyo: true, repeat: -1 });
    const step = () => {
      const next = pts.shift();
      if (!next) {
        walk.stop();
        view.sprite.y = 0;
        view.moving = false;
        this.onArrive(view);
        return;
      }
      const dist = Phaser.Math.Distance.Between(view.container.x, view.container.y, next.x, next.y);
      if (dist < 1) return step();
      view.sprite.setFlipX(next.x < view.container.x);
      view.tween = this.tweens.add({
        targets: view.container,
        x: next.x,
        y: next.y,
        duration: (dist / SPEED) * 1000,
        onUpdate: () => view.container.setDepth(1000 + view.container.y),
        onComplete: step,
      });
    };
    step();
  }

  onArrive(view) {
    if (view.leaving) {
      view.container.destroy();
      return;
    }
    if (view.pending) {
      const next = view.pending;
      view.pending = null;
      this.goTo(view, next);
      return;
    }
    this.setSitting(view, view.loc.kind === 'desk' || (view.loc.kind === 'spot' && view.loc.spot === 'sofa'));
    this.refreshMonitors();
  }

  setSitting(view, sitting) {
    view.sitting = sitting;
    const key = `char-${view.data.persona.id}`;
    const atDesk = sitting && view.loc.kind === 'desk' && !this.layout.locPos(view.loc, view.data).overflow;
    view.sprite.setTexture(atDesk ? `${key}-back` : key);
    if (sitting) view.sprite.setCrop(0, 0, 24, 28).setY(8);
    else view.sprite.setCrop().setY(0);
  }

  // Coloca o agente direto no destino (usado quando o mapa é redesenhado).
  snap(view) {
    view.tween?.stop();
    this.tweens.killTweensOf(view.sprite);
    view.moving = false;
    if (view.pending) {
      view.loc = view.pending;
      view.pending = null;
    }
    if (view.loc.kind === 'spawn') view.loc = { kind: 'desk' };
    const p = this.layout.locPos(view.loc, view.data);
    view.container.setPosition(p.x, p.y).setDepth(1000 + p.y);
    view.sprite.y = 0;
    this.onArrive(view);
  }

  removeAgent(view) {
    this.views.delete(view.data.id);
    view.leaving = true;
    view.pending = null;
    view.bubble.setText('Tchau! 👋').setVisible(true);
    if (view.moving) {
      view.tween?.stop();
      this.tweens.killTweensOf(view.sprite);
      view.moving = false;
    }
    const pos = { x: view.container.x, y: view.container.y };
    const pts = this.layout.path(view.loc, view.data, pos, { kind: 'spawn' });
    const last = pts[pts.length - 1];
    this.tweens.chain({
      targets: view.container,
      tweens: [
        ...pts.map((p, i) => ({
          x: p.x,
          y: p.y,
          duration: (Phaser.Math.Distance.BetweenPoints(i ? pts[i - 1] : pos, p) / SPEED) * 1000 + 1,
        })),
        { x: last.x - T, alpha: 0, duration: 400 },
      ],
      onComplete: () => view.container.destroy(),
    });
  }

  refreshMonitors() {
    for (const screen of this.monitors.values()) screen.setFillStyle(C.screenOff);
    for (const view of this.views.values()) {
      const { data } = view;
      if (view.moving || view.loc.kind !== 'desk' || data.status === 'idle') continue;
      const screen = this.monitors.get(`${data.project}:${data.deskIndex}`);
      screen?.setFillStyle(data.status === 'waiting' ? C.screenWait : C.screenOn);
    }
  }

  freeSlot(spot, except) {
    const taken = new Set();
    for (const v of this.views.values()) {
      if (v !== except && v.loc.kind === 'spot' && v.loc.spot === spot) taken.add(v.loc.slot);
    }
    let slot = 0;
    while (taken.has(slot)) slot++;
    return slot;
  }

  // --- mensagens do servidor -----------------------------------------------

  onState(msg) {
    const layoutChanged =
      !this.layout || JSON.stringify(msg.projects) !== JSON.stringify(this.layout.projects);
    if (layoutChanged) {
      this.layout = new Layout(msg.projects);
      this.drawWorld();
    }

    const perProject = {};
    for (const a of msg.agents) a.deskIndex = perProject[a.project] = (perProject[a.project] ?? -1) + 1;

    const seen = new Set();
    for (const data of msg.agents) {
      seen.add(data.id);
      let view = this.views.get(data.id);
      const isNew = !view;
      if (isNew) view = this.createAgent(data);
      const deskMoved = !isNew && view.data.deskIndex !== data.deskIndex;
      view.data = data;
      if (!isNew && (layoutChanged || (deskMoved && view.loc.kind === 'desk'))) this.snap(view);
      this.updateLabels(view);

      const headingToDesk = (view.pending ?? view.loc).kind === 'desk';
      if (isNew || (data.status !== 'idle' && !headingToDesk)) this.goTo(view, { kind: 'desk' });
    }
    for (const view of [...this.views.values()]) if (!seen.has(view.data.id)) this.removeAgent(view);

    this.refreshMonitors();
    this.updateHud(msg);
  }

  onWander(msg) {
    const view = this.views.get(msg.agent);
    if (!view || view.data.status !== 'idle') return;
    if (msg.spot === 'mesa') this.goTo(view, { kind: 'desk' });
    else this.goTo(view, { kind: 'spot', spot: msg.spot, slot: this.freeSlot(msg.spot, view) });
  }

  onHangout(msg) {
    const views = msg.agents.map((id) => this.views.get(id)).filter(Boolean);
    if (views.length < 2 || views.some((v) => v.data.status !== 'idle')) return;
    for (const v of views) this.goTo(v, { kind: 'spot', spot: msg.spot, slot: this.freeSlot(msg.spot, v) });

    const hangout = { views, lines: null };
    this.hangouts.set(msg.id, hangout);

    // Espera os dois chegarem e as falas chegarem do servidor; então conversam.
    let waited = 0;
    const check = this.time.addEvent({
      delay: 300,
      loop: true,
      callback: () => {
        waited += 300;
        const ready = views.every((v) => !v.moving) && hangout.lines;
        if (!ready && waited < 25000) return;
        check.remove();
        this.hangouts.delete(msg.id);
        let at = 0;
        for (const line of hangout.lines ?? []) {
          const ms = Math.min(6000, 2200 + line.text.length * 45);
          this.time.delayedCall(at, () => {
            const v = this.views.get(line.from);
            if (v && v.data.status === 'idle') this.say(v, line.text, ms);
          });
          at += ms + 300;
        }
      },
    });
  }

  onChat(msg) {
    const hangout = this.hangouts.get(msg.hangout);
    if (hangout) hangout.lines = msg.lines;
  }

  updateHud(msg) {
    const count = (s) => msg.agents.filter((a) => a.status === s).length;
    document.getElementById('count-working').textContent = count('working');
    document.getElementById('count-waiting').textContent = count('waiting');
    document.getElementById('count-idle').textContent = count('idle');
    document.getElementById('empty').hidden = msg.agents.length > 0;
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#1e2129',
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: OfficeScene,
});
