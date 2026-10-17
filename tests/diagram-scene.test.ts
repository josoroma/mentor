import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { DiagramPart } from '@/app/_components/explore/_diagram-model'
import {
  createPartGeometry,
  diagramCurve,
  surfaceAnchor,
} from '@/app/_components/explore/_diagram-scene'

const part = (shape: DiagramPart['shape']): DiagramPart => ({
  id: shape,
  label: shape,
  detail: 'A conceptual part',
  shape,
  position: [0, 0, 0],
  size: [2, 1, 3],
  separation: [0, 2, 0],
})

describe('spatial diagram geometry', () => {
  it.each(['box', 'cylinder', 'sphere', 'ring'] as const)(
    'keeps the authored dimensions of a %s',
    (shape) => {
      const model = part(shape)
      const geometry = createPartGeometry(model)
      geometry.computeBoundingBox()
      const size = geometry.boundingBox!.getSize(new THREE.Vector3())
      model.size.forEach((dimension, index) => {
        expect(size.getComponent(index)).toBeCloseTo(dimension, 5)
      })
      geometry.dispose()
    },
  )

  it('anchors connectors on the curved surface instead of its bounding box', () => {
    const model = part('sphere')
    const geometry = createPartGeometry(model)
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.updateMatrixWorld()
    const toward = new THREE.Vector3(3, 0, 3)
    const anchor = surfaceAnchor(mesh, toward, model.size)
    const surface = anchor.clone().addScaledVector(toward.normalize(), -0.035)
    const ellipsoid = surface.x ** 2 + (surface.y / 0.5) ** 2 + (surface.z / 1.5) ** 2
    expect(ellipsoid).toBeCloseTo(1, 1)
    expect(anchor.x).toBeLessThan(1)
    geometry.dispose()
    material.dispose()
  })

  it('keeps directed endpoints attached when parts move and reassemble', () => {
    const model = part('box')
    const geometry = createPartGeometry(model)
    const material = new THREE.MeshBasicMaterial()
    const from = new THREE.Mesh(geometry, material)
    const to = new THREE.Mesh(geometry, material)
    to.position.set(5, 0, 0)
    from.updateMatrixWorld()
    to.updateMatrixWorld()
    const rest = diagramCurve(from, to, model.size, model.size, 0)
    expect(rest.getPoint(0).x).toBeCloseTo(1.035, 3)
    expect(rest.getPoint(1).x).toBeCloseTo(3.965, 3)
    expect(rest.getTangent(1).x).toBeGreaterThan(0.99)

    to.position.y = 3
    to.updateMatrixWorld()
    const separated = diagramCurve(from, to, model.size, model.size, 0)
    expect(separated.getPoint(1).y).toBeGreaterThan(2)
    expect(separated.getTangent(1).dot(to.position.clone().normalize())).toBeGreaterThan(0.99)

    to.position.y = 0
    to.updateMatrixWorld()
    const restored = diagramCurve(from, to, model.size, model.size, 0)
    expect(restored.getPoint(0).toArray()).toEqual(rest.getPoint(0).toArray())
    expect(restored.getPoint(1).toArray()).toEqual(rest.getPoint(1).toArray())
    geometry.dispose()
    material.dispose()
  })

  it('draws self-loops with distinct surface endpoints and a finite return direction', () => {
    const model = part('sphere')
    const geometry = createPartGeometry(model)
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(2, 1, -3)
    mesh.updateMatrixWorld()
    const curve = diagramCurve(mesh, mesh, model.size, model.size, 0)
    expect(curve.getPoint(0).distanceTo(curve.getPoint(1))).toBeGreaterThan(1)
    expect(curve.getPoint(0.5).y).toBeGreaterThan(2)
    expect(curve.getTangent(1).toArray().every(Number.isFinite)).toBe(true)
    expect(curve.getTangent(1).length()).toBeCloseTo(1)
    geometry.dispose()
    material.dispose()
  })
})
