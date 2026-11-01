const B = window.BABYLON;

export function npcLabel(scene, parent, text, y = 2.2, width = 2.3) {
  const plane = B.MeshBuilder.CreatePlane(text, { width, height: 0.32 }, scene);
  plane.parent = parent;
  plane.position.y = y;
  plane.billboardMode = B.Mesh.BILLBOARDMODE_ALL;
  plane.isPickable = false;
  const texture = new B.DynamicTexture(
    text,
    { width: 1024, height: 128 },
    scene,
    false,
  );
  texture.hasAlpha = true;
  texture.drawText(
    text,
    null,
    85,
    'bold 62px sans-serif',
    '#fff4d1',
    '#173038ee',
    true,
  );
  const material = new B.StandardMaterial(text, scene);
  material.diffuseTexture = texture;
  material.emissiveColor = B.Color3.White();
  material.disableLighting = true;
  material.backFaceCulling = false;
  plane.material = material;
  plane.onDisposeObservable.addOnce(() => {
    material.dispose();
    texture.dispose();
  });
  return plane;
}
