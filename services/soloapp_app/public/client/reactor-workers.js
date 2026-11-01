import { WorkerCountSync } from './worker-controls.js';
import { LocalAvatar } from './local-avatar.js';
import { npcLabel } from './npc-label.js';
import { REACTOR_MAP } from '../shared/room.js';
import { resolveRoomMovement } from './room-collision.js';
import { WorkerNavigation } from './worker-navigation.js';
import {
  WORKER_COUNT,
  WORKER_REPLY,
  workerPose,
  workerDestination,
  WORKER_RADIUS,
  WorkerClock,
  WorkerProximity,
} from './worker-patrol.js';

const B = window.BABYLON;

export class ReactorWorkers {
  constructor(room) {
    this.room = room;
    this.clock = new WorkerClock();
    this.proximity = new WorkerProximity();
    this.sync = new WorkerCountSync((message) => room.network?.send(message));
    this.workers = Array.from({ length: WORKER_COUNT }, (_, index) =>
      this.create(index),
    );
    this.nextArrival = 0;
    this.ready = Promise.all(this.workers.map(({ avatar }) => avatar.ready));
    this.furniture = room.root.getChildMeshes().filter((mesh) => {
      if (
        mesh.isDescendantOf(room.exitPortal) ||
        mesh.isDescendantOf(room.instructor.avatar.root) ||
        this.workers.some((w) => mesh.isDescendantOf(w.avatar.root))
      )
        return false;
      mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      return box.minimumWorld.y < 1.75 && box.maximumWorld.y > 0.15;
    });
    this.navigation = new WorkerNavigation(
      this.furniture.map((mesh) => {
        const box = mesh.getBoundingInfo().boundingBox;
        return { min: box.minimumWorld, max: box.maximumWorld };
      }),
    );
    this.furniture = this.navigation.obstacles.map(
      (box) => this.furniture[box.sourceIndex],
    );
    this.gate = { x: 0, z: room.exitPortal.position.z + 0.65 };
    this.approach = this.navigation.nearest({
      x: 0,
      z: room.exitPortal.position.z - 1.2,
    });
    room.player.roomPeople = () =>
      this.visible && this.initialized
        ? this.workers.map((w) => this.person(w.avatar.root.position))
        : [];
  }

  create(index) {
    const avatar = new LocalAvatar(this.room.scene, 'scientist');
    avatar.root.name = `Room worker ${index + 1}`;
    avatar.root.parent = this.room.root;
    const label = npcLabel(
      this.room.scene,
      avatar.root,
      `Работник ${index + 1}`,
    );
    const bubble = npcLabel(
      this.room.scene,
      avatar.root,
      WORKER_REPLY,
      2.65,
      3.6,
    );
    bubble.setEnabled(false);
    return {
      index,
      avatar,
      label,
      bubble,
      replyUntil: 0,
      path: [],
      replanAt: 0,
    };
  }

  remove(worker) {
    // Stop any queued reply before disposing its speaker.
    if (this.room.instructor.speechAvatar === worker.avatar)
      this.room.instructor.finishWorkerReply();
    worker.avatar.setSpeaking(false);
    worker.label.dispose(false, true);
    worker.bubble.dispose(false, true);
    worker.avatar.root.dispose(false, true);
    this.workers = this.workers.filter((w) => w !== worker);
    this.proximity.reset();
  }

  reconcile(time, participants) {
    for (const worker of this.workers) {
      const leaving = worker.index >= this.sync.count;
      if (worker.leaving !== leaving) {
        if (
          !leaving &&
          worker.leaving &&
          worker.avatar.root.position.z > this.approach.z
        )
          worker.entering = true;
        worker.leaving = leaving;
        worker.path = [];
        worker.goalKey = null;
        worker.replanAt = 0;
      }
    }
    // Only one departing worker approaches the threshold; the others keep
    // walking until their turn instead of deadlocking shoulder-to-shoulder.
    if (!this.departing?.leaving || !this.workers.includes(this.departing))
      this.departing = this.workers
        .filter((w) => w.leaving)
        .sort(
          (a, b) =>
            Math.hypot(
              a.avatar.root.position.x - this.approach.x,
              a.avatar.root.position.z - this.approach.z,
            ) -
            Math.hypot(
              b.avatar.root.position.x - this.approach.x,
              b.avatar.root.position.z - this.approach.z,
            ),
        )[0];
    const missing = Array.from({ length: this.sync.count }, (_, i) => i).find(
      (i) => !this.workers.some((w) => w.index === i),
    );
    if (missing === undefined || time < this.nextArrival) return;
    // Departures have priority at the narrow common doorway.
    if (
      this.workers.some(
        (w) =>
          w.leaving &&
          Math.hypot(
            w.avatar.root.position.x,
            w.avatar.root.position.z - this.gate.z,
          ) < 2.8,
      )
    )
      return;
    const people = participants.concat(
      this.workers.map((w) => this.person(w.avatar.root.position)),
    );
    if (!this.navigation.clear(this.gate, this.approach, people)) return;
    const { door } = this.room;
    if (!door.sync.open) door.sync.request('open', REACTOR_MAP);
    if (!door.sync.open || door.amount < 0.95) return;
    const worker = this.create(missing);
    worker.avatar.root.position.set(this.gate.x, 0, this.gate.z);
    worker.entering = true;
    this.workers.push(worker);
    this.proximity.reset();
    this.nextArrival = time + 1400;
  }

  get visible() {
    return (
      this.room.active &&
      !this.room.physicalView &&
      this.room.player.worldMap === REACTOR_MAP
    );
  }

  person(position) {
    return { x: position.x, z: position.z, radius: WORKER_RADIUS };
  }

  participants() {
    const people = [
      this.person(this.room.player.position),
      this.person(this.room.instructor.avatar.root.position),
    ];
    for (const remote of this.room.network?.remotes.values() || [])
      if (remote.state?.map === REACTOR_MAP)
        people.push(this.person(remote.node.position));
    return people;
  }

  initialize(sharedTime, participants) {
    const occupied = [...participants];
    // A room entered later starts at the persisted count; live changes walk
    // through the door. Re-entry never replays old additions/removals.
    for (const worker of this.workers)
      if (worker.index >= this.sync.count) this.remove(worker);
    for (let index = 0; index < this.sync.count; index++)
      if (!this.workers.some((w) => w.index === index))
        this.workers.push(this.create(index));
    for (const worker of this.workers) {
      const pose = workerPose(worker.index, sharedTime, this.navigation);
      const free = this.navigation.nearest(pose, occupied);
      if (!free) continue;
      worker.avatar.root.position.set(free.x, 0, free.z);
      worker.avatar.root.rotationQuaternion.copyFrom(
        B.Quaternion.RotationYawPitchRoll(pose.yaw, 0, 0),
      );
      worker.path = [];
      worker.goalKey = null;
      worker.entering = worker.leaving = false;
      worker.replanAt = 0;
      occupied.push(this.person(free));
    }
    this.initialized = true;
    this.anchored = !!this.clock.lastStamp;
  }

  move(worker, index, dt, time, participants) {
    const position = worker.avatar.root.position;
    const people = participants.concat(
      this.workers
        .filter((w) => w !== worker)
        .map((w) => this.person(w.avatar.root.position)),
    );
    position.copyFrom(
      resolveRoomMovement(
        position,
        position,
        this.furniture,
        WORKER_RADIUS,
        people,
      ),
    );
    let destination = workerDestination(index, time, this.navigation);
    const departing = worker === this.departing;
    if (departing || worker.entering) {
      const atApproach =
        Math.hypot(position.x - this.approach.x, position.z - this.approach.z) <
        0.15;
      if (worker.entering && !departing && atApproach) worker.entering = false;
      else {
        const beyondApproach =
          position.z > this.approach.z - 0.15 && Math.abs(position.x) < 0.2;
        destination = {
          key: departing ? 'exit' : 'enter',
          target: this.approach,
        };
        if (departing && (atApproach || beyondApproach)) {
          const { door } = this.room;
          if (!door.sync.open) door.sync.request('open', REACTOR_MAP);
          if (
            door.sync.open &&
            door.amount >= 0.95 &&
            this.navigation.clear(position, this.gate, people)
          ) {
            destination = {
              key: 'cross-exit',
              target: this.gate,
              direct: true,
            };
          } else {
            worker.path = [];
            worker.goalKey = null;
            return { x: position.x, z: position.z, speed: 0 };
          }
        } else if (
          worker.entering &&
          position.z > this.room.exitPortal.position.z - 0.5
        ) {
          const { door } = this.room;
          if (!door.sync.open) door.sync.request('open', REACTOR_MAP);
          if (!door.sync.open || door.amount < 0.95) {
            worker.path = [];
            worker.goalKey = null;
            return { x: position.x, z: position.z, speed: 0 };
          }
        }
      }
    }
    const needsRoute = worker.path.length
      ? !this.navigation.clear(position, worker.path[0], people)
      : Math.hypot(
          position.x - destination.target.x,
          position.z - destination.target.z,
        ) > 0.05;
    if (
      worker.goalKey !== destination.key ||
      (needsRoute && time >= worker.replanAt)
    ) {
      worker.goalKey = destination.key;
      worker.path = destination.direct
        ? [destination.target]
        : this.navigation.path(position, destination.target, people).slice(1);
      worker.replanAt = time + 1200 + index * 130;
    }
    const before = position.clone();
    let budget = Math.min(Math.max(dt, 0), 0.1) * 0.7;
    while (budget > 1e-6 && worker.path.length) {
      const target = worker.path[0];
      const offset = new B.Vector3(
        target.x - position.x,
        0,
        target.z - position.z,
      );
      const distance = offset.length();
      if (distance < 0.01) {
        worker.path.shift();
        continue;
      }
      const step = Math.min(distance, budget);
      const next = position.add(offset.scale(step / distance));
      const resolved = resolveRoomMovement(
        position,
        next,
        this.furniture,
        WORKER_RADIUS,
        people,
      );
      position.copyFrom(resolved);
      budget -= step;
      if (B.Vector3.DistanceSquared(next, resolved) > 1e-8) break;
    }
    const delta = position.subtract(before);
    const travelled = delta.length();
    if (travelled > 1e-6)
      worker.avatar.root.rotationQuaternion.copyFrom(
        B.Quaternion.Slerp(
          worker.avatar.root.rotationQuaternion,
          B.Quaternion.RotationYawPitchRoll(
            Math.atan2(-delta.x, -delta.z),
            0,
            0,
          ),
          1 - Math.exp(-dt * 8),
        ),
      );
    return { x: position.x, z: position.z, speed: dt > 0 ? travelled / dt : 0 };
  }

  update(dt) {
    this.sync.tick();
    const visible = this.visible;
    if (!visible) {
      for (const worker of this.workers) {
        worker.avatar.root.setEnabled(false);
        worker.avatar.setSpeaking(false);
        worker.replyUntil = 0;
      }
      this.initialized = false;
      this.proximity.reset();
      return;
    }
    const now = performance.now();
    const sharedTime = this.clock.now();
    const participants = this.participants();
    const initializing =
      !this.initialized || (!this.anchored && this.clock.lastStamp);
    if (initializing) this.initialize(sharedTime, participants);
    const elapsed = initializing
      ? 0
      : Math.min(0.1, Math.max(0, (sharedTime - this.lastTime) / 1000));
    this.lastTime = sharedTime;
    this.reconcile(sharedTime, participants);
    for (const worker of this.workers) {
      if (
        worker.leaving &&
        Math.hypot(
          worker.avatar.root.position.x - this.gate.x,
          worker.avatar.root.position.z - this.gate.z,
        ) < 0.08
      )
        this.remove(worker);
    }
    const poses = this.workers.map((worker) => {
      worker.avatar.root.setEnabled(true);
      const pose = this.move(
        worker,
        worker.index,
        elapsed,
        sharedTime,
        participants,
      );
      worker.avatar.update(dt, pose.speed, 0, visible);
      worker.bubble.setEnabled(visible && now < worker.replyUntil);
      return pose;
    });
    if (document.hidden) {
      this.proximity.reset();
      return;
    }
    const chief = this.room.instructor;
    const index = this.proximity.poll(
      poses,
      this.room.player.position,
      now,
      chief.canReplyToVisitor(),
    );
    if (index !== null) {
      this.workers[index].replyUntil = now + 4500;
      this.workers[index].bubble.setEnabled(true);
      chief.replyToVisitor(WORKER_REPLY, this.workers[index].avatar);
    }
  }
}
