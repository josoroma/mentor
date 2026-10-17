'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  orbitAt,
  pendulumAt,
  waveAt,
  type SimulationKind,
  type SimulationParameters,
} from '@/lib/explore/models'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

type SceneProps = {
  kind: SimulationKind
  time: number
  parameters: SimulationParameters
  cameraPose: number[]
  onCameraChange: (pose: number[]) => void
  onFailure: () => void
}

export const ThreeScene = ({
  kind,
  time,
  parameters,
  cameraPose,
  onCameraChange,
  onFailure,
}: SceneProps) => {
  const container = useRef<HTMLDivElement>(null)
  const current = useRef({ time, parameters, cameraPose, onCameraChange, onFailure })
  current.current = { time, parameters, cameraPose, onCameraChange, onFailure }
  const sceneRef = useRef<{ refresh: () => void; setCamera: (pose: number[]) => void } | null>(null)

  useEffect(() => {
    const element = container.current
    if (!element) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'low-power',
      })
    } catch {
      current.current.onFailure()
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x000000, 0)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    const canvas = renderer.domElement
    canvas.setAttribute(
      'aria-label',
      `${kind} spatial model. Drag to orbit, Shift-drag to pan, scroll to zoom. Focus this view: arrow keys pan, Control and arrows orbit, plus and minus zoom, Home resets.`,
    )
    canvas.setAttribute('role', 'img')
    canvas.tabIndex = 0
    element.appendChild(canvas)
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = false
    controls.minDistance = 4
    controls.maxDistance = 18
    controls.maxTargetRadius = 5
    controls.maxPolarAngle = Math.PI * 0.93
    controls.minPolarAngle = Math.PI * 0.07
    controls.listenToKeyEvents(canvas)
    const setCamera = (pose: number[]) => {
      camera.position.set(pose[0], pose[1], pose[2])
      controls.target.set(pose[3], pose[4], pose[5])
      controls.update()
      renderer.render(scene, camera)
    }
    setCamera(current.current.cameraPose)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.5))
    const light = new THREE.DirectionalLight(0xffffff, 3)
    light.position.set(3, 6, 5)
    scene.add(light)
    const grid = new THREE.GridHelper(10, 20, 0x475569, 0x334155)
    grid.position.y = kind === 'orbit' ? -0.15 : -1.8
    const gridMaterial = grid.material as THREE.Material
    gridMaterial.transparent = true
    gridMaterial.opacity = 0.3
    scene.add(grid)

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0x60a5fa, roughness: 0.3, metalness: 0.1 }),
    )
    scene.add(marker)
    const fixed = new THREE.Mesh(
      new THREE.SphereGeometry(kind === 'orbit' ? 0.36 : 0.055, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0xa78bfa, roughness: 0.6 }),
    )
    fixed.position.set(0, kind === 'pendulum' ? 1.5 : 0, 0)
    scene.add(fixed)
    fixed.visible = kind !== 'wave'
    const pointCount = kind === 'pendulum' ? 2 : 129
    const positions = new Float32Array(pointCount * 3)
    const lineGeometry = new THREE.BufferGeometry()
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const line = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({ color: kind === 'orbit' ? 0x64748b : 0x60a5fa }),
    )
    scene.add(line)
    const refresh = () => {
      const props = current.current
      if (kind === 'pendulum') {
        const snapshot = pendulumAt(props.time, props.parameters)
        positions.set([0, 1.5, 0, snapshot.x, snapshot.y + 1.5, 0])
        marker.position.set(snapshot.x, snapshot.y + 1.5, 0)
      } else if (kind === 'orbit') {
        const snapshot = orbitAt(props.time, props.parameters)
        marker.position.set(snapshot.x, 0, snapshot.z)
        for (let index = 0; index < pointCount; index += 1) {
          const angle = (index / (pointCount - 1)) * Math.PI * 2
          positions.set(
            [
              props.parameters.radius * Math.cos(angle),
              0,
              props.parameters.radius * Math.sin(angle),
            ],
            index * 3,
          )
        }
      } else {
        for (let index = 0; index < pointCount; index += 1) {
          const x = -4 + (index / (pointCount - 1)) * 8
          positions.set([x, waveAt(x, props.time, props.parameters), 0], index * 3)
        }
        marker.position.set(0, waveAt(0, props.time, props.parameters), 0)
      }
      lineGeometry.attributes.position.needsUpdate = true
      lineGeometry.computeBoundingSphere()
      renderer.render(scene, camera)
    }
    const render = () => renderer.render(scene, camera)
    const saveCamera = () => {
      controls.target.clampScalar(-5, 5)
      controls.update()
      current.current.onCameraChange([...camera.position.toArray(), ...controls.target.toArray()])
    }
    const cameraKey = (event: KeyboardEvent) => {
      if (!['+', '=', '-', 'Home'].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'Home') setCamera([5, 3.5, 7, 0, 0, 0])
      else if (event.key === '-') controls.dollyOut(0.85)
      else controls.dollyIn(0.85)
      controls.update()
      saveCamera()
    }
    const cameraKeyUp = (event: KeyboardEvent) => {
      if (event.key.startsWith('Arrow')) saveCamera()
    }
    canvas.addEventListener('keydown', cameraKey)
    canvas.addEventListener('keyup', cameraKeyUp)
    controls.addEventListener('change', render)
    controls.addEventListener('end', saveCamera)
    const resize = new ResizeObserver(() => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (!width || !height) return
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      refresh()
    })
    resize.observe(element)
    const lost = (event: Event) => {
      event.preventDefault()
      current.current.onFailure()
    }
    canvas.addEventListener('webglcontextlost', lost)
    sceneRef.current = { refresh, setCamera }
    refresh()
    return () => {
      sceneRef.current = null
      resize.disconnect()
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('keydown', cameraKey)
      canvas.removeEventListener('keyup', cameraKeyUp)
      controls.removeEventListener('change', render)
      controls.removeEventListener('end', saveCamera)
      controls.dispose()
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.Line ||
          object instanceof THREE.LineSegments
        ) {
          object.geometry.dispose()
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          materials.forEach((material: THREE.Material) => material.dispose())
        }
      })
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    }
  }, [kind])

  useEffect(() => {
    sceneRef.current?.refresh()
  }, [time, parameters])
  useEffect(() => {
    sceneRef.current?.setCamera(cameraPose)
  }, [cameraPose])
  return <div ref={container} className={styles.threeScene} />
}
