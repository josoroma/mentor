'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  diagramBounds,
  partPosition,
  type DiagramPart,
} from '@/app/_components/explore/_diagram-model'
import {
  createPartGeometry,
  diagramCurve,
  type DiagramCameraCommand,
} from '@/app/_components/explore/_diagram-scene'
import styles from '@/app/_components/explore/diagram-scene.module.css'

type DiagramSceneProps = {
  parts: DiagramPart[]
  edges: Array<{ from: string; to: string; label: string }>
  separation: number
  selectedId: string
  activeIds: string[]
  cameraPose: number[]
  light: number
  shadows: boolean
  command: DiagramCameraCommand | null
  onSelect: (id: string) => void
  onCameraChange: (pose: number[]) => void
  onFailure: () => void
}

export const DiagramScene = ({
  parts,
  edges,
  separation,
  selectedId,
  activeIds,
  cameraPose,
  light,
  shadows,
  command,
  onSelect,
  onCameraChange,
  onFailure,
}: DiagramSceneProps) => {
  const container = useRef<HTMLDivElement>(null)
  const labels = useRef(new Map<string, HTMLButtonElement>())
  const current = useRef({
    parts,
    edges,
    separation,
    selectedId,
    activeIds,
    cameraPose,
    light,
    shadows,
    onSelect,
    onCameraChange,
    onFailure,
  })
  current.current = {
    parts,
    edges,
    separation,
    selectedId,
    activeIds,
    cameraPose,
    light,
    shadows,
    onSelect,
    onCameraChange,
    onFailure,
  }
  const runtime = useRef<{
    refresh: () => void
    setCamera: (pose: number[]) => void
    runCommand: (action: DiagramCameraCommand['action']) => void
  } | null>(null)
  const modelKey = JSON.stringify([parts, edges])

  useEffect(() => {
    const element = container.current
    if (!element) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'low-power',
        preserveDrawingBuffer: true,
      })
    } catch {
      current.current.onFailure()
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    renderer.setClearColor(0x111418, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    const canvas = renderer.domElement
    canvas.dataset.diagramCanvas = 'true'
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'group')
    canvas.setAttribute(
      'aria-label',
      'Spatial diagram. Drag to orbit, Shift-drag to pan, pinch to zoom. Focus the view to use the mouse wheel. Arrow keys pan, Control and arrows orbit, plus and minus zoom, Home frames all parts, F frames the selected part.',
    )
    element.appendChild(canvas)
    const scene = new THREE.Scene()
    const bounds = diagramBounds(current.current.parts, 0)
    const explodedBounds = diagramBounds(current.current.parts, 1)
    const center = new THREE.Vector3(...bounds.center)
    const radius = Math.max(bounds.radius, 2)
    const maximumRadius = Math.max(
      explodedBounds.radius + center.distanceTo(new THREE.Vector3(...explodedBounds.center)),
      radius,
    )
    const halfHeight = radius * 1.1
    const camera = new THREE.OrthographicCamera(
      -halfHeight,
      halfHeight,
      halfHeight,
      -halfHeight,
      0.1,
      maximumRadius * 20 + 100,
    )
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = false
    controls.enableZoom = false
    controls.zoomToCursor = true
    controls.rotateSpeed = 0.65
    controls.panSpeed = 0.8
    controls.minZoom = 0.2
    controls.maxZoom = 5
    controls.minPolarAngle = 0.015
    controls.maxPolarAngle = Math.PI * 0.49
    controls.cursor.copy(center)
    controls.maxTargetRadius = maximumRadius * 3
    const ambient = new THREE.HemisphereLight(0xe5edff, 0x171e29, 1.6)
    const keyLight = new THREE.DirectionalLight(0xffffff, 3)
    keyLight.position.copy(center).add(new THREE.Vector3(radius, maximumRadius * 2, radius))
    keyLight.target.position.copy(center)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(1024, 1024)
    keyLight.shadow.camera.left = -maximumRadius * 1.7
    keyLight.shadow.camera.right = maximumRadius * 1.7
    keyLight.shadow.camera.top = maximumRadius * 1.7
    keyLight.shadow.camera.bottom = -maximumRadius * 1.7
    keyLight.shadow.camera.near = 0.5
    keyLight.shadow.camera.far = maximumRadius * 7 + 40
    keyLight.shadow.normalBias = 0.045
    keyLight.shadow.bias = -0.00015
    const fillLight = new THREE.DirectionalLight(0x839bc7, 1.3)
    fillLight.position.copy(center).add(new THREE.Vector3(-radius, radius, -radius))
    scene.add(ambient, keyLight, keyLight.target, fillLight)

    const floorMinX = Math.min(bounds.min[0], explodedBounds.min[0])
    const floorMaxX = Math.max(bounds.max[0], explodedBounds.max[0])
    const floorMinZ = Math.min(bounds.min[2], explodedBounds.min[2])
    const floorMaxZ = Math.max(bounds.max[2], explodedBounds.max[2])
    const surfaceWidth = Math.max(floorMaxX - floorMinX + 4, 8)
    const surfaceDepth = Math.max(floorMaxZ - floorMinZ + 4, 8)
    const floorY = Math.min(bounds.min[1], explodedBounds.min[1]) - 0.35
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(surfaceWidth, 0.16, surfaceDepth),
      new THREE.MeshStandardMaterial({ color: 0x1e252e, roughness: 0.92, metalness: 0.05 }),
    )
    platform.position.set((floorMinX + floorMaxX) / 2, floorY - 0.08, (floorMinZ + floorMaxZ) / 2)
    platform.receiveShadow = true
    scene.add(platform)
    const grid = new THREE.GridHelper(Math.max(surfaceWidth, surfaceDepth), 24, 0x465263, 0x35404e)
    grid.position.set(platform.position.x, floorY + 0.003, platform.position.z)
    grid.scale.set(
      surfaceWidth / Math.max(surfaceWidth, surfaceDepth),
      1,
      surfaceDepth / Math.max(surfaceWidth, surfaceDepth),
    )
    const gridMaterial = grid.material as THREE.Material
    gridMaterial.transparent = true
    gridMaterial.opacity = 0.3
    scene.add(grid)

    const meshes = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>>()
    const outlines = new Map<string, THREE.LineSegments>()
    current.current.parts.forEach((part) => {
      const geometry = createPartGeometry(part)
      const material = new THREE.MeshStandardMaterial({
        color: 0x536071,
        roughness: 0.58,
        metalness: 0.22,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.userData.partId = part.id
      mesh.castShadow = true
      mesh.receiveShadow = true
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 24),
        new THREE.LineBasicMaterial({ color: 0x9ba9bc, transparent: true, opacity: 0.65 }),
      )
      mesh.add(outline)
      meshes.set(part.id, mesh)
      outlines.set(part.id, outline)
      scene.add(mesh)
    })
    const edgeObjects = current.current.edges.map((edge, index, all) => {
      const line = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x64758a, transparent: true, opacity: 0.85 }),
      )
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.09, 0.25, 10),
        new THREE.MeshStandardMaterial({ color: 0x91a3ba, roughness: 0.65 }),
      )
      scene.add(line, arrow)
      const duplicates = all.filter(
        (other) =>
          (other.from === edge.from && other.to === edge.to) ||
          (other.from === edge.to && other.to === edge.from),
      )
      const slot = duplicates.indexOf(edge)
      return {
        edge,
        index,
        line,
        arrow,
        offset: duplicates.length > 1 ? slot - (duplicates.length - 1) / 2 : 0,
      }
    })

    let disposed = false
    let inViewport = true
    let frame = 0
    let width = 1
    let height = 1
    let applyingPose = false
    let lastInputPose = ''
    let framedPartIds: string[] | null = null
    const labelRay = new THREE.Raycaster()
    const projectLabels = () => {
      const occupied: Array<{ x: number; y: number; width: number; height: number }> = []
      const order = [...current.current.parts].sort(
        (a, b) =>
          Number(b.id === current.current.selectedId) - Number(a.id === current.current.selectedId),
      )
      order.forEach((part) => {
        const label = labels.current.get(part.id)
        const mesh = meshes.get(part.id)
        if (!label || !mesh) return
        const anchor = mesh.position.clone().add(new THREE.Vector3(0, part.size[1] / 2 + 0.2, 0))
        const point = anchor.clone().project(camera)
        labelRay.setFromCamera(new THREE.Vector2(point.x, point.y), camera)
        const obstruction = labelRay.intersectObjects([...meshes.values()], false)[0]
        const occluded =
          obstruction &&
          obstruction.object !== mesh &&
          obstruction.distance < labelRay.ray.origin.distanceTo(anchor) - 0.1
        const x = ((point.x + 1) * width) / 2
        const y = ((1 - point.y) * height) / 2 - 14
        const labelWidth = label.offsetWidth || 130
        const labelHeight = label.offsetHeight || 27
        const overlaps = occupied.some(
          (rect) =>
            Math.abs(rect.x - x) < (rect.width + labelWidth) / 2 + 5 &&
            Math.abs(rect.y - y) < (rect.height + labelHeight) / 2 + 5,
        )
        const visible =
          point.z >= -1 &&
          point.z <= 1 &&
          x > labelWidth / 2 &&
          x < width - labelWidth / 2 &&
          y > labelHeight / 2 &&
          y < height - labelHeight / 2 &&
          !overlaps &&
          !occluded
        label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
        label.style.visibility = visible ? 'visible' : 'hidden'
        if (visible) occupied.push({ x, y, width: labelWidth, height: labelHeight })
      })
    }
    const render = () => {
      frame = 0
      if (disposed || document.hidden || !inViewport) return
      renderer.render(scene, camera)
      projectLabels()
    }
    const requestRender = () => {
      if (!frame && !disposed && !document.hidden && inViewport)
        frame = requestAnimationFrame(render)
    }
    const saveCamera = () => {
      if (!applyingPose) {
        current.current.onCameraChange([
          ...camera.position.toArray(),
          ...controls.target.toArray(),
          camera.zoom,
        ])
      }
    }
    const setCamera = (pose: number[]) => {
      if (pose.length !== 7 || !pose.every(Number.isFinite)) return
      const serialized = JSON.stringify(pose)
      if (lastInputPose === serialized) return
      lastInputPose = serialized
      framedPartIds = null
      applyingPose = true
      camera.position.fromArray(pose, 0)
      controls.target.fromArray(pose, 3)
      if (camera.position.distanceToSquared(controls.target) < 0.01) {
        camera.position.copy(controls.target).add(new THREE.Vector3(10, 8, 12))
      }
      camera.zoom = THREE.MathUtils.clamp(pose[6], controls.minZoom, controls.maxZoom)
      camera.updateProjectionMatrix()
      controls.update()
      applyingPose = false
      requestRender()
    }
    const frameParts = (selection: DiagramPart[], direction?: THREE.Vector3) => {
      framedPartIds = selection.map((part) => part.id)
      const liveBounds = diagramBounds(selection, current.current.separation)
      const target = new THREE.Vector3(...liveBounds.center)
      const normal = direction || camera.position.clone().sub(controls.target).normalize()
      camera.position.copy(target).addScaledVector(normal, Math.max(maximumRadius * 4, 20))
      controls.target.copy(target)
      controls.update()
      camera.updateMatrixWorld()
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
      const projectedX: number[] = []
      const projectedY: number[] = []
      for (const x of [liveBounds.min[0], liveBounds.max[0]]) {
        for (const y of [liveBounds.min[1], liveBounds.max[1]]) {
          for (const z of [liveBounds.min[2], liveBounds.max[2]]) {
            const point = new THREE.Vector3(x, y, z).sub(target)
            projectedX.push(point.dot(right))
            projectedY.push(point.dot(up))
          }
        }
      }
      const spanX = Math.max(...projectedX) - Math.min(...projectedX)
      const spanY = Math.max(...projectedY) - Math.min(...projectedY)
      camera.zoom = THREE.MathUtils.clamp(
        Math.min(
          ((camera.right - camera.left) * 0.72) / Math.max(spanX, 1),
          ((camera.top - camera.bottom) * 0.65) / Math.max(spanY, 1),
        ),
        controls.minZoom,
        controls.maxZoom,
      )
      camera.updateProjectionMatrix()
      controls.update()
    }
    const runCommand = (action: DiagramCameraCommand['action']) => {
      const allParts = current.current.parts
      framedPartIds = null
      if (action === 'overview') frameParts(allParts)
      else if (action === 'focus') {
        const part = allParts.find((item) => item.id === current.current.selectedId)
        if (part) frameParts([part])
      } else if (action === 'front')
        frameParts(allParts, new THREE.Vector3(0, 0.015, 1).normalize())
      else if (action === 'top') frameParts(allParts, new THREE.Vector3(0, 1, 0.015).normalize())
      else if (action === 'isometric')
        frameParts(allParts, new THREE.Vector3(10, 8, 12).normalize())
      else if (action === 'zoom-in') controls.dollyIn(0.82)
      else if (action === 'zoom-out') controls.dollyOut(0.82)
      else if (action === 'orbit-left') controls.rotateLeft(Math.PI / 12)
      else if (action === 'orbit-right') controls.rotateLeft(-Math.PI / 12)
      else
        controls.pan(
          action === 'left' ? 45 : action === 'right' ? -45 : 0,
          action === 'up' ? 45 : action === 'down' ? -45 : 0,
        )
      controls.update()
      saveCamera()
      requestRender()
    }
    const refresh = () => {
      const props = current.current
      props.parts.forEach((part) => {
        const mesh = meshes.get(part.id)!
        mesh.position.set(...partPosition(part, props.separation))
        const selected = props.selectedId === part.id
        const active = props.activeIds.includes(part.id)
        mesh.material.color.set(selected ? 0x527caf : active ? 0x466183 : 0x536071)
        mesh.material.emissive.set(selected ? 0x14273f : active ? 0x0c192b : 0x000000)
        const outline = outlines.get(part.id)!
        const material = outline.material as THREE.LineBasicMaterial
        material.color.set(selected ? 0x9fc6ff : active ? 0x82b4f8 : 0x9ba9bc)
        material.opacity = selected || active ? 0.9 : 0.5
      })
      scene.updateMatrixWorld(true)
      edgeObjects.forEach(({ edge, line, arrow, offset }) => {
        const from = meshes.get(edge.from)
        const to = meshes.get(edge.to)
        if (!from || !to) return
        const fromPart = props.parts.find((part) => part.id === edge.from)!
        const toPart = props.parts.find((part) => part.id === edge.to)!
        const curve = diagramCurve(from, to, fromPart.size, toPart.size, offset)
        line.geometry.setFromPoints(curve.getPoints(32))
        line.geometry.computeBoundingSphere()
        const tangent = curve.getTangent(1).normalize()
        arrow.position.copy(curve.getPoint(1)).addScaledVector(tangent, -0.125)
        arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent)
        const highlighted = edge.from === props.selectedId || edge.to === props.selectedId
        line.material.color.set(highlighted ? 0x82b4f8 : 0x64758a)
        arrow.material.color.set(highlighted ? 0x82b4f8 : 0x91a3ba)
      })
      ambient.intensity = 0.6 + props.light * 0.9
      keyLight.intensity = props.light * 3
      fillLight.intensity = props.light * 0.85
      if (renderer.shadowMap.enabled !== props.shadows) {
        renderer.shadowMap.enabled = props.shadows
        meshes.forEach((mesh) => {
          mesh.material.needsUpdate = true
        })
        platform.material.needsUpdate = true
      }
      requestRender()
    }
    const resize = () => {
      width = Math.max(element.clientWidth, 1)
      height = Math.max(element.clientHeight, 1)
      renderer.setSize(width, height)
      camera.left = (-halfHeight * width) / height
      camera.right = (halfHeight * width) / height
      camera.updateProjectionMatrix()
      if (framedPartIds) {
        frameParts(current.current.parts.filter((part) => framedPartIds?.includes(part.id)))
      }
      requestRender()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    const intersection = new IntersectionObserver(([entry]) => {
      inViewport = entry.isIntersecting
      if (!inViewport && frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      requestRender()
    })
    intersection.observe(element)
    const visibility = () => {
      if (document.hidden && frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      requestRender()
    }
    let pointerStart: { x: number; y: number; id: number; moved: boolean } | null = null
    const manualCamera = () => {
      framedPartIds = null
    }
    const pointerDown = (event: PointerEvent) => {
      controls.enableZoom = true
      canvas.focus({ preventScroll: true })
      pointerStart = event.isPrimary
        ? { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false }
        : null
    }
    const pointerMove = (event: PointerEvent) => {
      if (
        pointerStart &&
        Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5
      ) {
        pointerStart.moved = true
      }
    }
    const pointerCancel = () => {
      pointerStart = null
    }
    const pointerUp = (event: PointerEvent) => {
      const start = pointerStart
      pointerStart = null
      if (
        !start ||
        start.moved ||
        start.id !== event.pointerId ||
        event.button !== 0 ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
      )
        return
      const rect = canvas.getBoundingClientRect()
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      const ray = new THREE.Raycaster()
      ray.setFromCamera(pointer, camera)
      const hit = ray.intersectObjects([...meshes.values()], false)[0]
      if (hit) current.current.onSelect(hit.object.userData.partId)
    }
    const focus = () => {
      controls.enableZoom = true
    }
    const blur = () => {
      controls.enableZoom = false
    }
    const keyDown = (event: KeyboardEvent) => {
      const mapping: Record<string, DiagramCameraCommand['action']> = {
        Home: 'overview',
        f: 'focus',
        F: 'focus',
        '+': 'zoom-in',
        '=': 'zoom-in',
        '-': 'zoom-out',
        ArrowLeft: event.ctrlKey || event.metaKey ? 'orbit-left' : 'left',
        ArrowRight: event.ctrlKey || event.metaKey ? 'orbit-right' : 'right',
        ArrowUp: 'up',
        ArrowDown: 'down',
      }
      if (!mapping[event.key]) return
      event.preventDefault()
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        controls.rotateUp(event.key === 'ArrowUp' ? Math.PI / 12 : -Math.PI / 12)
        controls.update()
        saveCamera()
      } else runCommand(mapping[event.key])
    }
    const contextLost = (event: Event) => {
      event.preventDefault()
      current.current.onFailure()
    }
    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointermove', pointerMove)
    canvas.addEventListener('pointerup', pointerUp)
    canvas.addEventListener('pointercancel', pointerCancel)
    canvas.addEventListener('focus', focus)
    canvas.addEventListener('blur', blur)
    canvas.addEventListener('keydown', keyDown)
    canvas.addEventListener('webglcontextlost', contextLost)
    controls.addEventListener('change', requestRender)
    controls.addEventListener('start', manualCamera)
    controls.addEventListener('end', saveCamera)
    document.addEventListener('visibilitychange', visibility)
    runtime.current = { refresh, setCamera, runCommand }
    resize()
    setCamera(current.current.cameraPose)
    const isDefaultPose = current.current.cameraPose.every(
      (value, index) => value === [10, 8, 12, 0, 0, 0, 1][index],
    )
    if (isDefaultPose) frameParts(current.current.parts, new THREE.Vector3(10, 8, 12).normalize())
    refresh()
    return () => {
      disposed = true
      runtime.current = null
      cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', pointerCancel)
      canvas.removeEventListener('focus', focus)
      canvas.removeEventListener('blur', blur)
      canvas.removeEventListener('keydown', keyDown)
      canvas.removeEventListener('webglcontextlost', contextLost)
      controls.removeEventListener('change', requestRender)
      controls.removeEventListener('start', manualCamera)
      controls.removeEventListener('end', saveCamera)
      controls.dispose()
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose()
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          materials.forEach((material: THREE.Material) => material.dispose())
        }
      })
      keyLight.shadow.map?.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    }
  }, [modelKey])

  useEffect(() => {
    runtime.current?.refresh()
  }, [separation, selectedId, activeIds, light, shadows])
  useEffect(() => {
    runtime.current?.setCamera(cameraPose)
  }, [cameraPose])
  useEffect(() => {
    if (command) runtime.current?.runCommand(command.action)
  }, [command])

  return (
    <div className={styles.scene}>
      <div ref={container} className={styles.canvasHost} />
      <div className={styles.labels}>
        {parts.map((part) => (
          <button
            key={part.id}
            type="button"
            ref={(element) => {
              if (element) labels.current.set(part.id, element)
              else labels.current.delete(part.id)
            }}
            className={styles.label}
            data-selected={selectedId === part.id}
            aria-label={`Inspect ${part.label}`}
            aria-pressed={selectedId === part.id}
            title={part.label}
            onClick={() => onSelect(part.id)}
          >
            {part.label}
          </button>
        ))}
      </div>
    </div>
  )
}
