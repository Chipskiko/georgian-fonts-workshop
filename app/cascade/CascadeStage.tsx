"use client";

import { useEffect, useRef, useState } from "react";
import Matter from "matter-js";
import styles from "./cascade.module.css";

const MAX_LETTERS = 60;
const DROP_INTERVAL_MS = 800;
const DROP_MIN_AGE_MS = 4000;

// Standard Georgian QWERTY mapping — pressing a Latin key spawns the corresponding Georgian glyph.
const QWERTY_TO_GEORGIAN: Record<string, string> = {
  a: "ა", b: "ბ", c: "ც", d: "დ", e: "ე", f: "ფ", g: "გ", h: "ჰ",
  i: "ი", j: "ჯ", k: "კ", l: "ლ", m: "მ", n: "ნ", o: "ო", p: "პ",
  q: "ქ", r: "რ", s: "ს", t: "ტ", u: "უ", v: "ვ", w: "წ", x: "ხ",
  y: "ყ", z: "ზ",
};

function toGeorgian(ch: string): string {
  if (ch.length !== 1) return ch;
  const code = ch.codePointAt(0) ?? 0;
  // already a Georgian glyph (Mkhedruli range) → keep
  if (code >= 0x10d0 && code <= 0x10fa) return ch;
  return QWERTY_TO_GEORGIAN[ch.toLowerCase()] ?? ch;
}

type Letter = {
  id: number;
  body: Matter.Body;
  char: string;
  fontId: string | null;
  size: number;
  born: number;
};

export function CascadeStage({ fontIds }: { fontIds: string[] }) {
  const [, setTick] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<Matter.Engine | null>(null);
  const lettersRef = useRef<Letter[]>([]);
  const idRef = useRef(0);
  const lastDropAtRef = useRef(0);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const engine = Matter.Engine.create({
      gravity: { x: 0, y: 1.4 },
      enableSleeping: false,
    });
    engineRef.current = engine;

    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const wallThickness = 200;
    const floor = Matter.Bodies.rectangle(w / 2, h + wallThickness / 2, w * 4, wallThickness, { isStatic: true });
    const left = Matter.Bodies.rectangle(-wallThickness / 2, h / 2, wallThickness, h * 4, { isStatic: true });
    const right = Matter.Bodies.rectangle(w + wallThickness / 2, h / 2, wallThickness, h * 4, { isStatic: true });
    Matter.Composite.add(engine.world, [floor, left, right]);

    // Drag interaction
    const mouse = Matter.Mouse.create(stage);
    const anyMouse = mouse as unknown as { mousewheel?: EventListener };
    if (anyMouse.mousewheel) {
      stage.removeEventListener("wheel", anyMouse.mousewheel as EventListener);
      stage.removeEventListener("DOMMouseScroll", anyMouse.mousewheel as EventListener);
    }
    const mouseConstraint = Matter.MouseConstraint.create(engine, {
      mouse,
      constraint: { stiffness: 0.2, damping: 0.1, render: { visible: false } },
    });
    Matter.Composite.add(engine.world, mouseConstraint);

    inputRef.current?.focus();

    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(33, t - last);
      last = t;
      Matter.Engine.update(engine, dt, 1);

      const now = performance.now();
      const stageH = stage.clientHeight;
      const survivors: Letter[] = [];

      // Queue-based drop: at most one letter starts dropping per DROP_INTERVAL_MS,
      // oldest first.
      if (now - lastDropAtRef.current > DROP_INTERVAL_MS) {
        for (const l of lettersRef.current) {
          if (l.body.collisionFilter.mask === 0) continue;
          if (now - l.born < DROP_MIN_AGE_MS) break;
          l.body.collisionFilter.mask = 0;
          Matter.Body.setVelocity(l.body, {
            x: l.body.velocity.x,
            y: Math.max(2, l.body.velocity.y),
          });
          lastDropAtRef.current = now;
          break;
        }
      }

      for (const l of lettersRef.current) {
        if (l.body.collisionFilter.mask === 0 && l.body.position.y > stageH + l.size * 2) {
          Matter.Composite.remove(engine.world, l.body);
          continue;
        }
        survivors.push(l);
      }
      lettersRef.current = survivors;

      setTick((n) => (n + 1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => {
      const nw = stage.clientWidth;
      const nh = stage.clientHeight;
      Matter.Body.setPosition(floor, { x: nw / 2, y: nh + wallThickness / 2 });
      Matter.Body.setPosition(right, { x: nw + wallThickness / 2, y: nh / 2 });
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      Matter.Engine.clear(engine);
      engineRef.current = null;
    };
  }, []);

  function spawn(char: string) {
    const stage = stageRef.current;
    const engine = engineRef.current;
    if (!stage || !engine) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const fontId = fontIds.length > 0 ? fontIds[Math.floor(Math.random() * fontIds.length)] : null;
    const minDim = Math.min(w, h);
    const size = Math.min(0.18 * minDim, 80 + Math.random() * 100);
    const radius = size * 0.42;

    const x = Math.random() * (w - size) + size / 2;
    const body = Matter.Bodies.circle(x, -size, radius, {
      restitution: 0.35,
      friction: 0.25,
      frictionAir: 0.005,
      density: 0.001,
    });
    Matter.Body.setVelocity(body, { x: (Math.random() - 0.5) * 6, y: 0 });
    Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.15);
    Matter.Composite.add(engine.world, body);

    const letter: Letter = {
      id: idRef.current++,
      body,
      char,
      fontId,
      size,
      born: performance.now(),
    };

    const next = [...lettersRef.current, letter];
    while (next.length > MAX_LETTERS) {
      const dead = next.shift();
      if (dead) Matter.Composite.remove(engine.world, dead.body);
    }
    lettersRef.current = next;
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key.length === 1) {
      spawn(toGeorgian(e.key));
    } else if (e.key === "Backspace") {
      const last = lettersRef.current.pop();
      if (last && engineRef.current) Matter.Composite.remove(engineRef.current.world, last.body);
    }
  }

  function clearAll() {
    if (!engineRef.current) return;
    for (const l of lettersRef.current) {
      Matter.Composite.remove(engineRef.current.world, l.body);
    }
    lettersRef.current = [];
    setTick((n) => (n + 1) % 1_000_000);
  }

  return (
    <div
      ref={stageRef}
      className={styles.stage}
      onMouseUp={() => inputRef.current?.focus()}
      onTouchEnd={() => inputRef.current?.focus()}
    >
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        autoFocus
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        lang="ka"
        inputMode="text"
        onKeyDown={handleKey}
        onChange={() => {}}
        value=""
        aria-label="type to cascade letters"
      />

      <div
        className={styles.controls}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => {
            clearAll();
            inputRef.current?.focus();
          }}
        >
          clear
        </button>
        <button type="button" onClick={() => inputRef.current?.focus()}>type</button>
      </div>

      {lettersRef.current.length === 0 ? (
        <div className={styles.hint} onClick={() => inputRef.current?.focus()}>
          <p>დაწერე რამე</p>
        </div>
      ) : null}

      {lettersRef.current.map((l) => (
        <span
          key={l.id}
          className={styles.letter}
          style={{
            fontFamily: l.fontId ? `"${l.fontId}"` : "serif",
            fontSize: `${l.size}px`,
            transform:
              `translate3d(${l.body.position.x}px, ${l.body.position.y}px, 0) ` +
              `translate(-50%, -50%) ` +
              `rotate(${l.body.angle}rad)`,
          }}
        >
          {l.char}
        </span>
      ))}
    </div>
  );
}
