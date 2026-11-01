import { loadAssetContainer } from './asset-cache.js';
import { avatar, avatarLabel } from './scene.js';
import { DEFAULT_AVATAR, findAvatar } from './avatar-catalog.js';
const B = window.BABYLON;

// Rigged bases use procedural poses; explicitly static catalogue entries keep
// their authored pose and use the same player transform and camera visibility.
export class LocalAvatar {
  constructor(scene, initialId = DEFAULT_AVATAR, peerId = null) {
    this.scene = scene;
    this.root = new B.TransformNode(
      peerId === null ? 'local-player' : `remote-player-${peerId}`,
      scene,
    );
    this.root.rotationQuaternion = B.Quaternion.Identity();
    this.root.setEnabled(false);
    this.fallback = avatar(scene, peerId ?? 0, true);
    this.fallback.parent = this.root;
    if (peerId !== null) {
      this.label = avatarLabel(scene, peerId);
      this.label.parent = this.root;
    }
    this.phase = 0;
    this.stride = 0;
    this.motionTime = 0;
    this.speaking = false;
    this.mouthTargets = [];
    this.generation = 0;
    this.root.onDisposeObservable.addOnce(() => {
      this.generation++;
      this.container?.dispose();
    });
    this.select(initialId);
  }

  select(id) {
    const definition = findAvatar(id);
    if (!definition) return Promise.resolve(false);
    this.ready = this.load(definition, ++this.generation);
    return this.ready;
  }

  async load(definition, generation) {
    const scene = this.scene;
    let container;
    try {
      container = await loadAssetContainer(definition.url, scene);
      if (this.root.isDisposed() || generation !== this.generation) {
        container.dispose();
        return false;
      }
      // Authored morph clips must not compete with the player's procedural pose.
      for (const animation of container.animationGroups) animation.stop();
      const skeleton = container.skeletons[0];
      const rigged = definition.rigged !== false;
      if (rigged && !skeleton) throw Error('Avatar has no skeleton');
      const names = [
        'upperarm_l',
        'upperarm_r',
        'thigh_l',
        'thigh_r',
        'calf_l',
        'calf_r',
        'Head',
      ];
      const optional = [
        'pelvis',
        'spine_01',
        'spine_02',
        'lowerarm_l',
        'lowerarm_r',
        'hand_l',
        'hand_r',
        'foot_l',
        'foot_r',
        'ball_l',
        'ball_r',
      ];
      const joints = new Map();
      const boneNode = (name) =>
        skeleton.bones
          .find((bone) => bone.name === (definition.bones?.[name] ?? name))
          ?.getTransformNode();
      for (const name of rigged ? [...names, ...optional] : []) {
        const node = boneNode(name);
        if (!node?.rotationQuaternion) {
          if (optional.includes(name)) continue;
          throw Error('Missing avatar joint: ' + name);
        }
        const inverse = node.parent.computeWorldMatrix(true).clone().invert();
        // Elbow hinges follow the authored forearm, not world X (which would
        // twist a T/A-pose arm instead of bending it toward the front).
        const hand = name.startsWith('lowerarm_')
          ? boneNode(name.replace('lowerarm_', 'hand_'))
          : null;
        let bend = null;
        if (hand) {
          hand.computeWorldMatrix(true);
          node.computeWorldMatrix(true);
          const direction = hand
            .getAbsolutePosition()
            .subtract(node.getAbsolutePosition())
            .normalize();
          const axis = B.Vector3.Cross(direction, B.Axis.Z);
          if (axis.lengthSquared() > 0.001)
            bend = B.Vector3.TransformNormal(axis, inverse).normalize();
        }
        joints.set(name, {
          node,
          rest: node.rotationQuaternion.clone(),
          bend,
          x: B.Vector3.TransformNormal(B.Axis.X, inverse).normalize(),
          y: B.Vector3.TransformNormal(B.Axis.Y, inverse).normalize(),
          z: B.Vector3.TransformNormal(B.Axis.Z, inverse).normalize(),
        });
      }
      const previousContainer = this.container,
        previousModel = this.model;
      const model = new B.TransformNode('human-avatar', scene);
      model.parent = this.root;
      // glTF faces +Z; the game's right-handed player frame faces -Z.
      model.rotation.y = Math.PI;
      model.scaling.setAll(1.8 / definition.height);
      model.position.y = -definition.floor * model.scaling.y;
      container.addAllToScene();
      for (const node of container.rootNodes) node.parent = model;
      for (const mesh of container.meshes) {
        mesh.isPickable = false;
        // Animated limbs may leave the tight T-pose bounds (notably in overview).
        if (mesh.skeleton) mesh.alwaysSelectAsActiveMesh = true;
      }
      this.joints = rigged ? joints : null;
      this.armRestAngle = definition.armRestAngle ?? 1.35;
      this.model = model;
      this.skeleton = skeleton;
      this.container = container;
      this.mouthTargets = [
        ...new Set(container.meshes.map((mesh) => mesh.morphTargetManager)),
      ]
        .filter(
          (manager) =>
            manager &&
            Number.isInteger(definition.mouthMorph) &&
            definition.mouthMorph < manager.numTargets,
        )
        .map((manager) => {
          const target = manager.getTarget(definition.mouthMorph);
          // Only the jaw shape is used procedurally. Keep one shader slot even
          // at zero weight, avoiding a shader rebuild on every mouth closure.
          manager.areUpdatesFrozen = true;
          for (let i = manager.numTargets - 1; i >= 0; i--) {
            const other = manager.getTarget(i);
            if (other !== target) manager.removeTarget(other);
          }
          manager.optimizeInfluencers = false;
          manager.numMaxInfluencers = 1;
          manager.areUpdatesFrozen = false;
          return target;
        });
      this.groundReferences = [];
      this.floorOffset = model.position.y;
      if (this.joints) {
        const stride = this.stride;
        this.stride = 0;
        this.pose(0);
        const inverseRoot = this.root.computeWorldMatrix(true).clone().invert();
        this.groundReferences = ['foot_l', 'foot_r', 'ball_l', 'ball_r']
          .map((name) => joints.get(name)?.node)
          .filter(Boolean)
          .map((node) => {
            node.computeWorldMatrix(true);
            return {
              node,
              y: B.Vector3.TransformCoordinates(
                node.getAbsolutePosition(),
                inverseRoot,
              ).y,
            };
          });
        this.stride = stride;
        this.pose(0);
      }
      this.id = definition.id;
      this.error = null;
      this.fallback.setEnabled(false);
      previousContainer?.dispose();
      previousModel?.dispose();
      return true;
    } catch (error) {
      container?.dispose();
      if (generation !== this.generation || this.root.isDisposed())
        return false;
      this.error = error;
      console.warn(
        'Local avatar: keeping the previous avatar or capsule fallback.',
        error,
      );
      return false;
    }
  }

  rotate(name, x, z = 0, y = 0, hinge = false) {
    const joint = this.joints.get(name);
    if (!joint) return;
    const delta = B.Quaternion.RotationAxis(
      hinge && joint.bend ? joint.bend : joint.x,
      x,
    )
      .multiply(B.Quaternion.RotationAxis(joint.z, z))
      .multiply(B.Quaternion.RotationAxis(joint.y, y));
    joint.node.rotationQuaternion.copyFrom(delta.multiply(joint.rest));
  }

  setSpeaking(active) {
    if (active && !this.speaking) this.speechTime = 0;
    this.speaking = active;
    // Cancellation/mute must close the mouth even without another render frame.
    if (!active) for (const target of this.mouthTargets) target.influence = 0;
  }

  pose(pitch) {
    const stride = this.stride;
    const sway = Math.sin(this.phase) * stride;
    const breath = Math.sin(this.motionTime * 1.8);
    const gesture = this.speaking ? Math.sin(this.speechTime * 3.7) : 0;
    for (const [side, offset, sign] of [
      ['l', 0, -1],
      ['r', Math.PI, 1],
    ]) {
      const phase = this.phase + offset;
      const swing = Math.max(0, -Math.sin(phase));
      const hip = -Math.cos(phase) * 0.48 * stride;
      const knee =
        (swing * 1.15 + Math.max(0, Math.sin(phase)) * 0.08) * stride;
      this.rotate('thigh_' + side, hip);
      this.rotate('calf_' + side, knee);
      // Counter-rotate the ankle: keep the stance sole level and lift the toes
      // during recovery, rather than dragging a rigid straight leg forward.
      this.rotate('foot_' + side, -hip - knee - swing * 0.12 * stride);
      this.rotate('ball_' + side, swing * 0.16 * stride);
      this.rotate(
        'upperarm_' + side,
        -hip * 0.8 + gesture * 0.055 * sign,
        sign * (this.armRestAngle + breath * 0.012 + Math.abs(gesture) * 0.04),
      );
      this.rotate(
        'lowerarm_' + side,
        0.1 +
          stride * (0.12 + swing * 0.25) +
          Math.max(0, gesture * sign) * 0.22,
        0,
        0,
        true,
      );
      this.rotate(
        'hand_' + side,
        Math.sin(phase + 0.4) * stride * 0.06 + gesture * 0.04,
      );
    }
    this.rotate('pelvis', 0, sway * 0.025, sway * 0.035);
    this.rotate(
      'spine_01',
      stride * 0.035 + breath * 0.006,
      -sway * 0.018,
      -sway * 0.025,
    );
    this.rotate('spine_02', 0, 0, -sway * 0.02 + gesture * 0.025);
    this.rotate(
      'Head',
      -Math.max(-0.7, Math.min(0.7, pitch)) + gesture * 0.025,
    );
    // SpeechSynthesis exposes lifecycle events, not audio samples/phonemes.
    // A bounded syllable envelope supplies repeated closures while it speaks.
    const mouth = this.speaking
      ? 0.82 *
        Math.max(0, Math.sin(this.speechTime * 29)) *
        (0.72 + 0.28 * Math.sin(this.speechTime * 11) ** 2)
      : 0;
    for (const target of this.mouthTargets) target.influence = mouth;
    this.groundFeet();
  }

  groundFeet() {
    if (!this.groundReferences?.length) return;
    // Correct only the visual child, never the collision/player root. Measure in
    // the root's frame so grounding also works on the curved planet surface.
    this.model.position.y = this.floorOffset;
    const inverseRoot = this.root.computeWorldMatrix(true).clone().invert();
    let lift = Infinity;
    for (const { node, y } of this.groundReferences) {
      node.computeWorldMatrix(true);
      lift = Math.min(
        lift,
        B.Vector3.TransformCoordinates(node.getAbsolutePosition(), inverseRoot)
          .y - y,
      );
    }
    this.model.position.y -= Math.max(-0.08, Math.min(0.15, lift));
  }

  update(dt, speed, pitch, visible) {
    this.root.setEnabled(visible);
    if (!visible) this.setSpeaking(false);
    if (this.model && !this.joints) return;
    if (!this.joints) {
      this.fallback
        .getChildMeshes()
        .find((mesh) => mesh.name === 'look-direction').rotation.x = pitch;
      return;
    }
    // Clamp stalls so returning to a background tab cannot jerk the whole rig.
    const elapsed = Math.max(0, Math.min(dt, 0.1));
    const travel = Math.max(0, Math.min(speed, 6));
    const moving = Math.min(1, travel / 1.1);
    this.stride += (moving - this.stride) * (1 - Math.exp(-elapsed * 12));
    this.motionTime += elapsed;
    if (this.speaking) this.speechTime += elapsed;
    // A slow worker still takes visible steps; blend their amplitude on stopping.
    if (travel > 0.01)
      this.phase =
        (this.phase + elapsed * (0.6 + travel * 0.3) * 2 * Math.PI) %
        (2 * Math.PI);
    this.pose(pitch);
  }
}
