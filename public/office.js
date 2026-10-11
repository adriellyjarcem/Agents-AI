// Escritório virtual em Phaser: monta o mapa com o tileset de pixel art
// (public/assets, gerado por scripts/build-tileset.mjs), cria um personagem
// por agente e move cada um de acordo com o estado que chega do servidor.

/* global Phaser */

const T = 32; // tamanho de um "tile" no mundo (o pixel art de 16 px é desenhado em 2x)
const PX = 2; // escala do pixel art
const ROOM_W = 14; // sala em tiles
const ROOM_H = 11;
const HALL_H = 7; // corredor principal (com café, sofá...) no topo
const CORR_H = 2; // corredor acima de cada fileira extra de salas
const COLS = 3; // salas por fileira
const GARDEN_W = 7; // jardim à direita, também serve de passagem vertical
const SPEED = 130; // px por segundo
const DESKS_PER_ROOM = 6;
const AISLE = 2.9 * T; // corredor interno da sala, abaixo dos móveis da parede
const SOFA = { x: 17.6 * T, y: 2.2 * T };
const LABEL_DEPTH = 100000;

// Quadros da folha de personagens (public/assets/chars.png)
const FRAME = { down: 0, up: 3, side: 6, sitBack: 9, sitFront: 10 };

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
      return { x: room.x + (10 + (k % 3)) * T, y: room.y + AISLE, laneX: room.x + 9 * T, overflow: true };
    }
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = room.x + (1.5 + col * 4) * T;
    const y = room.y + (3.6 + row * 3.6) * T;
    return { deskX: x, deskY: y, x: x + 1.5 * T, y: y + 2.4 * T, laneX: room.x + (1 + col * 4) * T };
  }

  spot(name, slot = 0) {
    const s = slot % 4;
    switch (name) {
      case 'cafe': return { x: (1.6 + s * 1.6) * T, y: 2.8 * T };
      case 'bebedouro': return { x: (7.6 + s * 1.6) * T, y: 2.8 * T };
      case 'sofa': return { x: SOFA.x + ((slot % 3) - 1) * 1.4 * T, y: SOFA.y - 0.25 * T, depth: SOFA.y + 1 };
      case 'estante': return { x: (25.6 + s * 1.6) * T, y: 2.8 * T };
      case 'jardim': return { x: this.hallW + (2.6 + s * 1.6) * T, y: 4.5 * T };
      default: return { x: 2 * T, y: 2.8 * T };
    }
  }

  spawn() {
    return { x: T, y: this.corridorY(0) };
  }

  // Posição final de um "lugar" (mesa, ponto de encontro, porta da sala, entrada).
  locPos(loc, agent) {
    if (loc.kind === 'spot') return this.spot(loc.spot, loc.slot);
    if (loc.kind === 'door') {
      const room = this.room(agent.project);
      return room ? { x: room.doorX, y: room.y + 0.6 * T } : this.spawn();
    }
    if (loc.kind === 'desk') {
      const room = this.room(agent.project);
      return room ? this.desk(room, agent.deskIndex) : this.spawn();
    }
    return this.spawn();
  }

  // Caminho de saída de um lugar até o corredor (ou trilha do jardim).
  exitOf(loc, agent, pos) {
    const doorRoom = loc.kind === 'door' && this.room(agent.project);
    if (doorRoom) return { row: doorRoom.r, pts: [{ x: doorRoom.doorX, y: this.corridorY(doorRoom.r) }] };
    if (loc.kind === 'desk') {
      const room = this.room(agent.project);
      if (room) {
        const d = this.desk(room, agent.deskIndex);
        const aisle = room.y + AISLE;
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
    const doorRoom = loc.kind === 'door' && this.room(agent.project);
    if (doorRoom) return { row: doorRoom.r, pts: [{ x: doorRoom.doorX, y: this.corridorY(doorRoom.r) }, target] };
    if (loc.kind === 'desk') {
      const room = this.room(agent.project);
      if (room) {
        const d = this.desk(room, agent.deskIndex);
        const aisle = room.y + AISLE;
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
// Personagens: a folha-modelo usa cores-chave que trocamos pelas da persona
// ---------------------------------------------------------------------------

const hex = (s) => parseInt(s.replace('#', ''), 16);

function rgb(color, f = 1) {
  const n = hex(color);
  return [16, 8, 0].map((shift) => Math.round(((n >> shift) & 255) * f));
}

function makeCharacterTexture(scene, persona) {
  const key = `char-${persona.id}`;
  if (scene.textures.exists(key)) return key;

  const swap = new Map([
    [0xff00ff, rgb(persona.cabelo)],
    [0xc000c0, rgb(persona.cabelo, 0.75)],
    [0x00ffff, rgb(persona.pele)],
    [0x00c0c0, rgb(persona.pele, 0.85)],
    [0xffff00, rgb(persona.camisa)],
    [0xc0c000, rgb(persona.camisa, 0.75)],
    [0x00ff00, rgb(persona.calca)],
    [0x00c000, rgb(persona.calca, 0.75)],
  ]);

  const src = scene.textures.get('chars').getSourceImage();
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = 24;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, persona.cabeloLongo ? 24 : 0, src.width, 24, 0, 0, src.width, 24);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const to = swap.get((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
    if (to && img.data[i + 3]) img.data.set(to, i);
  }
  ctx.putImageData(img, 0, 0);

  const tex = scene.textures.addCanvas(key, canvas);
  for (let i = 0; i < src.width / 16; i++) tex.add(i, 0, i * 16, 0, 16, 24);
  tex.setFilter(Phaser.Textures.FilterMode.NEAREST);

  for (const [dir, first] of Object.entries({ down: FRAME.down, up: FRAME.up, side: FRAME.side })) {
    scene.anims.create({
      key: `${key}-${dir}`,
      frames: [first + 1, first, first + 2, first].map((frame) => ({ key, frame })),
      frameRate: 8,
      repeat: -1,
    });
  }
  return key;
}

// ---------------------------------------------------------------------------
// Barras de uso (limite de 5 h e semanal)
// ---------------------------------------------------------------------------

function formatReset(resetsAt) {
  if (!resetsAt) return '';
  const ms = resetsAt * 1000 - Date.now();
  if (ms <= 0) return 'reiniciando…';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `reinicia em ${min} min`;
  if (min < 24 * 60) return `reinicia em ${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}min`;
  const when = new Date(resetsAt * 1000);
  const day = when.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  const time = when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `reinicia ${day}, ${time}`;
}

function renderUsage(usage) {
  let any = false;
  for (const meter of document.querySelectorAll('#usage .meter')) {
    const w = usage[meter.dataset.window];
    if (!w || (w.resets_at && w.resets_at * 1000 < Date.now())) {
      meter.hidden = true;
      continue;
    }
    any = true;
    meter.hidden = false;
    const pct = Math.max(0, Math.min(100, w.used_percentage));
    meter.querySelector('.bar i').style.width = `${pct}%`;
    meter.querySelector('.pct').textContent = `${Math.round(w.used_percentage)}%`;
    meter.querySelector('.reset').textContent = formatReset(w.resets_at);
    meter.classList.toggle('warn', pct >= 60 && pct < 85);
    meter.classList.toggle('danger', pct >= 85);
  }
  document.getElementById('usage').hidden = !any;
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
    this.worldObjects = [];
    this.allViews = new Set(); // inclui quem está indo embora
  }

  preload() {
    this.load.atlas('office', 'assets/office.png', 'assets/office.json');
    this.load.image('chars', 'assets/chars.png');
  }

  create() {
    // Pixel art: amplia sem borrar.
    this.textures.get('office').setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.cameras.main.setBackgroundColor('#1e2129');
    this.setupCameraControls();
    this.scale.on('resize', () => this.fitCamera());
    this.connect();
    // Atualiza o "reinicia em..." mesmo sem novidades do servidor.
    this.time.addEvent({ delay: 30000, loop: true, callback: () => renderUsage(this.usage ?? {}) });
  }

  update() {
    for (const v of this.allViews) v.label.setPosition(v.sprite.x, v.sprite.y);
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

  // Um objeto do tileset com a base em (x, y). A profundidade segue o y, então
  // o que está mais "para baixo" na tela aparece na frente (inclusive agentes).
  prop(frame, x, y, depth = y) {
    const img = this.add.image(x, y, 'office', frame).setOrigin(0.5, 1).setScale(PX).setDepth(depth);
    this.worldObjects.push(img);
    return img;
  }

  // Área coberta repetindo um tile (pisos, paredes, grama).
  fill(frame, x, y, w, h, depth = -10000) {
    const t = this.add.tileSprite(x, y, w, h, 'office', frame).setOrigin(0).setTileScale(PX).setDepth(depth);
    this.worldObjects.push(t);
    return t;
  }

  drawWorld() {
    for (const o of this.worldObjects) o.destroy();
    this.worldObjects = [];
    this.monitors.clear();
    const L = this.layout;

    // Pisos e parede do corredor principal
    this.fill('floor_hall', 0, 0, L.hallW, HALL_H * T);
    for (let r = 1; r < L.rows; r++) this.fill('floor_hall', 0, L.rowTop(r) - CORR_H * T, L.hallW, CORR_H * T);
    this.fill('wall', 0, 0, L.hallW, 0.4 * T, -8000);

    // Jardim; a trilha também liga as fileiras de salas
    this.fill('grass', L.hallW, 0, GARDEN_W * T, L.height);
    this.fill('path', L.gardenX - T / 2, 0, T, L.height, -9500);
    let seed = 7;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < (L.height / T) * 2; i++) {
      const x = L.hallW + (2 + Math.floor(rnd() * 5)) * T;
      const y = Math.floor(rnd() * (L.height / T)) * T;
      this.fill('grass_alt', x, y, T, T, -9600);
    }
    this.prop('umbrella', L.hallW + 4.3 * T, 3.9 * T);
    this.prop('bench', L.hallW + 4.6 * T, 6.6 * T);
    this.prop('bush', L.hallW + 6.3 * T, 1.2 * T);
    this.prop('lamp', L.hallW + 0.55 * T, 3 * T);
    for (let y = 10; y < L.height / T - 1; y += 5) {
      this.prop('tree', L.hallW + (4.2 + ((y / 5) % 2) * 1.2) * T, y * T);
      this.prop('lamp', L.hallW + 0.55 * T, (y + 1.5) * T);
      this.prop('bush', L.hallW + 3 * T, (y + 2.6) * T);
    }

    // Corredor principal: copa, bebedouro, sala de estar, estante
    this.prop('counter', 2.6 * T, 2 * T);
    this.prop('coffee_machine', 2.1 * T, 1.45 * T, 2 * T + 1);
    this.prop('cups', 3.4 * T, 1.1 * T, 2 * T + 1);
    this.prop('plant_tall', 5.2 * T, 2.2 * T);
    this.prop('water_cooler', 7.6 * T, 2.3 * T);
    this.prop('plant', 13.6 * T, 1.9 * T);
    this.prop('rug', SOFA.x, 4.6 * T, -9000);
    this.prop('sofa', SOFA.x, SOFA.y);
    this.prop('coffee_table', SOFA.x, 3.9 * T);
    this.prop('pouf_yellow', SOFA.x - 2.4 * T, 4.1 * T);
    this.prop('pouf_red', SOFA.x + 2.4 * T, 4.1 * T);
    this.prop('plant', 21.6 * T, 1.9 * T);
    this.prop('clock', 23.6 * T, 1.0 * T, -7000);
    this.prop('bookshelf', 26.2 * T, 2.3 * T);
    this.prop('plant', 28.4 * T, 1.9 * T);
    this.prop('printer', 31.2 * T, 1.9 * T);
    this.prop('cabinet', 33.4 * T, 2.1 * T);
    this.prop('bin', 34.8 * T, 2 * T);
    this.prop('plant_tall', 39.5 * T, 2.2 * T);

    for (const project of L.projects) this.drawRoom(L.room(project), project);
    this.fitCamera();
  }

  drawRoom(room, project) {
    const w = ROOM_W * T;
    const h = ROOM_H * T;
    const t = 0.3 * T;
    this.fill('floor_room', room.x, room.y, w, h);

    // Paredes, com a porta no meio da parede de cima
    this.fill('wall', room.x, room.y, room.doorX - T - room.x, t, -8000);
    this.fill('wall', room.doorX + T, room.y, room.x + w - room.doorX - T, t, -8000);
    this.fill('wall', room.x, room.y + h - t, w, t, -8000);
    this.fill('wall', room.x, room.y, t, h, -8000);
    this.fill('wall', room.x + w - t, room.y, t, h, -8000);

    // Encostados na parede de cima, sem invadir o corredor interno da sala
    this.prop('bookshelf', room.x + 1.6 * T, room.y + 2.4 * T);
    this.prop('cabinet', room.x + 3.6 * T, room.y + 2.3 * T);
    this.prop('clock', room.doorX + 2 * T, room.y + 1.2 * T, -7000);
    this.prop('whiteboard', room.x + 11 * T, room.y + 2 * T);
    this.prop('plant', room.x + 13.1 * T, room.y + 2.4 * T);
    this.prop('plant', room.x + 0.9 * T, room.y + 10.6 * T);
    this.prop('plant_tall', room.x + 13.1 * T, room.y + 10.6 * T);
    this.prop('bin', room.x + 9.5 * T, room.y + 10.5 * T);

    for (let i = 0; i < DESKS_PER_ROOM; i++) {
      const d = this.layout.desk(room, i);
      const cx = d.deskX + 1.5 * T;
      const base = d.deskY + 1.75 * T;
      this.prop('desk', cx, base);
      this.monitors.set(`${project}:${i}`, this.prop('monitor_off', cx, d.deskY + 1.15 * T, base + 1));
      this.prop('keyboard', cx, d.deskY + 1.45 * T, base + 1);
      if (i % 2 === 0) this.prop('mug', cx + 1.1 * T, d.deskY + 1.3 * T, base + 1);
      // A cadeira fica logo atrás de quem senta (que aparece de costas sobre ela).
      this.prop('chair', d.x, d.y + 0.55 * T, d.y - 1);
    }

    // Placa com o nome do projeto, acima da porta
    const sign = this.add
      .text(room.doorX - 1.2 * T, room.y - 4, project, {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#2b2f3a',
        backgroundColor: '#fffdf5',
        padding: { x: 6, y: 2 },
        resolution: 2,
      })
      .setOrigin(1, 1)
      .setDepth(-7000);
    this.worldObjects.push(sign);
  }

  // --- agentes --------------------------------------------------------------

  createAgent(data) {
    const key = makeCharacterTexture(this, data.persona);
    // Subagentes entram pela porta da sala; sessões, pela entrada do escritório.
    const startLoc = data.parent ? { kind: 'door' } : { kind: 'spawn' };
    const start = this.layout.locPos(startLoc, data);
    const sprite = this.add.sprite(start.x, start.y, key, FRAME.down).setOrigin(0.5, 1).setScale(PX);
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
      .text(0, -50, '', {
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
    // Nome e balão ficam numa camada acima de tudo, seguindo o personagem.
    const label = this.add.container(start.x, start.y, [name, dot, bubble]).setDepth(LABEL_DEPTH);

    const view = {
      data,
      key,
      sprite,
      label,
      name,
      dot,
      bubble,
      loc: startLoc,
      moving: false,
      pending: null,
      chatUntil: 0,
    };
    this.views.set(data.id, view);
    this.allViews.add(view);
    sprite.setDepth(start.y);
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
    const { sprite } = view;
    const pts = this.layout.path(view.loc, view.data, { x: sprite.x, y: sprite.y }, loc);
    view.loc = loc;
    view.moving = true;

    const step = () => {
      const next = pts.shift();
      if (!next) {
        view.moving = false;
        this.onArrive(view);
        return;
      }
      const dx = next.x - sprite.x;
      const dy = next.y - sprite.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) return step();
      // Anima andando na direção do próximo trecho.
      const dir = Math.abs(dx) > Math.abs(dy) ? 'side' : dy < 0 ? 'up' : 'down';
      sprite.setFlipX(dir === 'side' && dx < 0).play(`${view.key}-${dir}`, true);
      view.tween = this.tweens.add({
        targets: sprite,
        x: next.x,
        y: next.y,
        duration: (dist / SPEED) * 1000,
        onUpdate: () => sprite.setDepth(sprite.y),
        onComplete: step,
      });
    };
    step();
  }

  onArrive(view) {
    view.sprite.stop();
    if (view.leaving) {
      this.tweens.add({
        targets: [view.sprite, view.label],
        alpha: 0,
        duration: 400,
        onComplete: () => {
          view.sprite.destroy();
          view.label.destroy();
          this.allViews.delete(view);
        },
      });
      return;
    }
    if (view.pending) {
      const next = view.pending;
      view.pending = null;
      this.goTo(view, next);
      return;
    }
    this.pose(view);
    this.refreshMonitors();
  }

  // Postura parada: sentado na mesa (de costas), no sofá (de frente) ou em pé.
  pose(view) {
    const { sprite, loc } = view;
    const pos = this.layout.locPos(loc, view.data);
    sprite.setFlipX(false).setDepth(pos.depth ?? sprite.y);
    if (loc.kind === 'desk' && !pos.overflow) sprite.setFrame(FRAME.sitBack);
    else if (loc.kind === 'spot' && loc.spot === 'sofa') sprite.setFrame(FRAME.sitFront);
    else if (loc.kind === 'spot' && loc.spot !== 'jardim') sprite.setFrame(FRAME.up); // de frente para o café, a estante...
    else sprite.setFrame(FRAME.down);
  }

  // Vira um agente para o outro (usado nas conversas).
  face(view, other) {
    if (view.moving || (view.loc.kind === 'spot' && view.loc.spot === 'sofa')) return;
    view.sprite.setFrame(FRAME.side).setFlipX(other.sprite.x < view.sprite.x);
  }

  // Coloca o agente direto no destino (usado quando o mapa é redesenhado).
  snap(view) {
    view.tween?.stop();
    view.moving = false;
    if (view.pending) {
      view.loc = view.pending;
      view.pending = null;
    }
    if (view.loc.kind === 'spawn' || view.loc.kind === 'door') view.loc = { kind: 'desk' };
    const p = this.layout.locPos(view.loc, view.data);
    view.sprite.setPosition(p.x, p.y);
    this.onArrive(view);
  }

  removeAgent(view) {
    this.views.delete(view.data.id);
    view.leaving = true;
    view.pending = null;
    view.bubble.setText('Tchau! 👋').setVisible(true);
    if (view.moving) {
      view.tween?.stop();
      view.moving = false;
    }
    this.goTo(view, view.data.parent ? { kind: 'door' } : { kind: 'spawn' });
  }

  refreshMonitors() {
    for (const screen of this.monitors.values()) screen.setFrame('monitor_off');
    for (const view of this.views.values()) {
      const { data } = view;
      if (view.moving || view.loc.kind !== 'desk' || data.status === 'idle') continue;
      const screen = this.monitors.get(`${data.project}:${data.deskIndex}`);
      screen?.setFrame(data.status === 'waiting' ? 'monitor_wait' : 'monitor_on');
    }
  }

  freeSlot(spot, except) {
    const taken = new Set();
    for (const v of this.views.values()) {
      const loc = v.pending ?? v.loc; // quem ainda está a caminho também ocupa a vaga
      if (v !== except && loc.kind === 'spot' && loc.spot === spot) taken.add(loc.slot);
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
        this.face(views[0], views[1]);
        this.face(views[1], views[0]);
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
    this.usage = msg.usage ?? {};
    renderUsage(this.usage);
  }
}

// Exposto no console (window.office) para depuração.
window.office = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#1e2129',
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: OfficeScene,
});
