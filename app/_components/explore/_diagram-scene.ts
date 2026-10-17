import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { DiagramPart } from '@/app/_components/explore/_diagram-model'

export type DiagramCameraCommand = {
  id: number
  action:
    | 'overview'
    | 'focus'
    | 'front'
    | 'top'
    | 'isometric'
    | 'zoom-in'
    | 'zoom-out'
    | 'left'
    | 'right'
    | 'up'
    | 'down'
    | 'orbit-left'
    | 'orbit-right'
}

export const createPartGeometry = (part: DiagramPart) => {
  const [width, height, depth] = part.size
  if (part.shape === 'sphere') {
    return new THREE.SphereGeometry(0.5, 32, 20).scale(width, height, depth)
  }
  if (part.shape === 'cylinder') {
    return new THREE.CylinderGeometry(0.5, 0.5, 1, 40).scale(width, height, depth)
  }
  if (part.shape === 'ring') {
    return new THREE.TorusGeometry(0.36, 0.14, 16, 48)
      .rotateX(Math.PI / 2)
      .scale(width, height / 0.28, depth)
  }
  return new RoundedBoxGeometry(width, height, depth, 2, Math.min(...part.size) * 0.07)
}

// Use the rendered surface as the connector anchor, including scaled curved parts.
export const surfaceAnchor = (mesh: THREE.Mesh, toward: THREE.Vector3, size: number[]) => {
  const direction = toward.clone().sub(mesh.position).normalize()
  const reach = Math.hypot(...size) + 1
  const ray = new THREE.Raycaster(
    mesh.position.clone().addScaledVector(direction, reach),
    direction.clone().negate(),
    0,
    reach * 2,
  )
  const hit = ray.intersectObject(mesh, false)[0]
  if (hit) return hit.point.addScaledVector(direction, 0.035)
  // A ring can have an empty centerline. Anchor at its outer rim instead.
  return mesh.position.clone().add(new THREE.Vector3(size[0] / 2 + 0.035, 0, 0))
}

export const diagramCurve = (
  from: THREE.Mesh,
  to: THREE.Mesh,
  fromSize: number[],
  toSize: number[],
  alternate: number,
) => {
  if (from === to) {
    const [width, height, depth] = fromSize
    const center = from.position
    return new THREE.CatmullRomCurve3([
      surfaceAnchor(from, center.clone().add(new THREE.Vector3(width, height * 0.3, 0)), fromSize),
      center.clone().add(new THREE.Vector3(width / 2 + 0.8, height + 0.5, -depth * 0.3)),
      center.clone().add(new THREE.Vector3(-width / 2 - 0.8, height + 0.5, -depth * 0.3)),
      surfaceAnchor(from, center.clone().add(new THREE.Vector3(-width, height * 0.3, 0)), fromSize),
    ])
  }
  const start = surfaceAnchor(from, to.position, fromSize)
  const end = surfaceAnchor(to, from.position, toSize)
  const midpoint = start.clone().lerp(end, 0.5)
  // Separate parallel connections without introducing new graph relationships.
  if (alternate) {
    midpoint.y += alternate * 0.4
  }
  return new THREE.CatmullRomCurve3([start, midpoint, end])
}
