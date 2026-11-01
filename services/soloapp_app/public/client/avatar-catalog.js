export const AVATARS = Object.freeze([
  {
    id: 'scientist',
    name: 'Учёный',
    description: 'Scientist Broken · CC BY 4.0',
    url: new URL('../assets/avatar/scientist.glb', import.meta.url).href,
    height: 5.824408214585046,
    floor: 0.06538959324388105,
    armRestAngle: 0.6,
    // Verified jaw-open shape in scientist.glb's unnamed MorphBake targets.
    // Apply to the face AND mouth meshes to keep teeth and lips together.
    mouthMorph: 26,
    bones: {
      upperarm_l: 'ValveBiped.Bip01_L_UpperArm_59',
      upperarm_r: 'ValveBiped.Bip01_R_UpperArm_87',
      thigh_l: 'ValveBiped.Bip01_L_Thigh_22',
      thigh_r: 'ValveBiped.Bip01_R_Thigh_27',
      calf_l: 'ValveBiped.Bip01_L_Calf_21',
      calf_r: 'ValveBiped.Bip01_R_Calf_26',
      Head: 'ValveBiped.Bip01_Head1_31',
      pelvis: 'ValveBiped.Bip01_Pelvis_96',
      spine_01: 'ValveBiped.Bip01_Spine_95',
      spine_02: 'ValveBiped.Bip01_Spine1_94',
      lowerarm_l: 'ValveBiped.Bip01_L_Forearm_58',
      lowerarm_r: 'ValveBiped.Bip01_R_Forearm_86',
      hand_l: 'ValveBiped.Bip01_L_Hand_55',
      hand_r: 'ValveBiped.Bip01_R_Hand_83',
      foot_l: 'ValveBiped.Bip01_L_Foot_20',
      foot_r: 'ValveBiped.Bip01_R_Foot_25',
      ball_l: 'ValveBiped.Bip01_L_Toe0_19',
      ball_r: 'ValveBiped.Bip01_R_Toe0_24',
    },
  },
  {
    id: 'male',
    name: 'Атлет',
    description: 'Мужской аватар',
    url: new URL('../assets/avatar/player.glb', import.meta.url).href,
    height: 1.81958638317883,
    floor: -0.009509669616818428,
  },
  {
    id: 'female',
    name: 'Атлетка',
    description: 'Женский аватар',
    url: new URL('../assets/avatar/player-female.glb', import.meta.url).href,
    height: 1.7750510573387146,
    floor: -0.008407175540924072,
  },
  {
    id: 'uraraka',
    name: 'Очако Урарака',
    description: 'Статическая поза · Padalab · CC BY-NC-SA',
    url: new URL('../assets/avatar/uraraka-ochako.glb', import.meta.url).href,
    height: 1.8824622025713325,
    floor: -0.0009810319170355797,
    rigged: false,
  },
]);
export const DEFAULT_AVATAR = AVATARS[0].id;
export const AVATAR_STORAGE_KEY = 'microplanet.avatar.v1';
export const findAvatar = (id) => AVATARS.find((avatar) => avatar.id === id);

// A device preference, independent of the login token and safe in private mode.
export class AvatarPreferences {
  constructor(storage = () => window.localStorage) {
    this.storage = storage;
    this.id = DEFAULT_AVATAR;
    this.saved = false;
    try {
      const id = this.storage().getItem(AVATAR_STORAGE_KEY);
      if (findAvatar(id)) {
        this.id = id;
        this.saved = true;
      }
    } catch {
      /* Storage may be denied; a session-only choice still works. */
    }
  }

  save(id) {
    if (!findAvatar(id)) throw Error('Unknown avatar');
    this.id = id;
    try {
      this.storage().setItem(AVATAR_STORAGE_KEY, id);
      this.saved = true;
      return true;
    } catch {
      this.saved = false;
      return false;
    }
  }
}
