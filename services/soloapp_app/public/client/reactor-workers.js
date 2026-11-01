import { LocalAvatar } from './local-avatar.js';
import { npcLabel } from './npc-label.js';
import {
  WORKER_COUNT,
  WORKER_REPLY,
  workerPose,
  WorkerClock,
  WorkerProximity,
} from './worker-patrol.js';

const B = window.BABYLON;

export class ReactorWorkers {
  constructor(room) {
    this.room = room;
    this.clock = new WorkerClock();
    this.proximity = new WorkerProximity();
    this.workers = Array.from({ length: WORKER_COUNT }, (_, index) => {
      const avatar = new LocalAvatar(room.scene, 'scientist');
      avatar.root.name = `Room worker ${index + 1}`;
      avatar.root.parent = room.root;
      const label = npcLabel(room.scene, avatar.root, `Работник ${index + 1}`);
      const bubble = npcLabel(room.scene, avatar.root, WORKER_REPLY, 2.65, 3.6);
      bubble.setEnabled(false);
      return { avatar, label, bubble, replyUntil: 0 };
    });
    this.ready = Promise.all(this.workers.map(({ avatar }) => avatar.ready));
  }

  update(dt) {
    const visible = this.room.active && !this.room.physicalView;
    if (!visible) {
      for (const worker of this.workers) {
        worker.avatar.root.setEnabled(false);
        worker.replyUntil = 0;
      }
      this.proximity.reset();
      return;
    }
    const now = performance.now();
    const sharedTime = this.clock.now();
    const poses = this.workers.map((worker, index) => {
      const pose = workerPose(index, sharedTime);
      worker.avatar.root.position.set(pose.x, 0, pose.z);
      worker.avatar.root.rotationQuaternion.copyFrom(
        B.Quaternion.RotationYawPitchRoll(pose.yaw, 0, 0),
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
      chief.replyToVisitor(WORKER_REPLY);
    }
  }
}
