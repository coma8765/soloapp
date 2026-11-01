const B = window.BABYLON;

// Shared geometry/materials with independent transforms and picking targets.
export class MeshInstances {
  constructor(scene) {
    this.scene = scene;
    this.sources = new Map();
  }

  create(kind, options, material, name, parent, position) {
    const geometry = kind + JSON.stringify(options);
    const key = `${geometry}:${material.uniqueId}`;
    let source = this.sources.get(key);
    if (!source) {
      source = B.MeshBuilder[kind](name + ' template', options, this.scene);
      source.material = material;
      source.isVisible = false;
      source.isPickable = false;
      source.metadata = { instanceGeometry: geometry };
      this.sources.set(key, source);
    }
    const mesh = source.createInstance(name);
    mesh.parent = parent;
    mesh.position.copyFromFloats(...position);
    mesh.isPickable = false;
    return mesh;
  }

  recolor(mesh, material) {
    if (mesh.material === material) return mesh;
    if (!mesh.isAnInstance) {
      mesh.material = material;
      return mesh;
    }
    const original = mesh.sourceMesh;
    const key = `${original.metadata.instanceGeometry}:${material.uniqueId}`;
    let source = this.sources.get(key);
    if (!source) {
      source = original.clone(mesh.name + ' template', null, true);
      source.material = material;
      source.isVisible = false;
      source.isPickable = false;
      this.sources.set(key, source);
    }
    const replacement = source.createInstance(mesh.name);
    replacement.parent = mesh.parent;
    replacement.position.copyFrom(mesh.position);
    replacement.rotation.copyFrom(mesh.rotation);
    replacement.rotationQuaternion = mesh.rotationQuaternion?.clone() || null;
    replacement.scaling.copyFrom(mesh.scaling);
    replacement.isPickable = mesh.isPickable;
    replacement.metadata = mesh.metadata;
    mesh.dispose();
    return replacement;
  }
}
