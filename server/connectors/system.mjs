/**
 * This machine: CPU, memory, disks, GPU where one reports itself, and the busiest processes.
 * Read through the `systeminformation` package, which asks the operating system and nothing
 * else. No network, no account, nothing written.
 *
 * A reading at or over its threshold needs attention. Thresholds are percentages:
 * `SYSTEM_CPU_WARN`, `SYSTEM_MEM_WARN`, `SYSTEM_DISK_WARN`, `SYSTEM_GPU_WARN` (default 90).
 */
import { enabledIds, envNumber } from './lib.mjs'

const GB = 1024 ** 3
const pct = (n) => `${Math.round(n)}%`
const gb = (bytes) => `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1)} GB`

/** Small or pseudo filesystems say nothing about whether the machine is filling up. */
const MIN_DISK_BYTES = 1 * GB

/** Built with the library passed in so tests can hand it canned readings. */
export function createSystemConnector(loadSi = () => import('systeminformation').then((m) => m.default ?? m)) {
  return {
    id: 'system',
    label: 'This machine',
    intervalMs: 10_000,
    enabled: (env) => enabledIds(env).has('system'),

    async poll({ env, now }) {
      const si = await loadSi()
      // Each reading is allowed to fail alone: no GPU, or a process list the OS will not
      // hand over, should not cost the CPU and memory rows.
      const read = (fn) => Promise.resolve().then(fn).catch(() => null)
      const [load, mem, disks, graphics, procs] = await Promise.all([
        read(() => si.currentLoad()),
        read(() => si.mem()),
        read(() => si.fsSize()),
        read(() => si.graphics()),
        read(() => si.processes()),
      ])
      const warn = {
        cpu: envNumber(env, 'SYSTEM_CPU_WARN', 90),
        mem: envNumber(env, 'SYSTEM_MEM_WARN', 90),
        disk: envNumber(env, 'SYSTEM_DISK_WARN', 90),
        gpu: envNumber(env, 'SYSTEM_GPU_WARN', 90),
      }
      const items = []

      if (load && Number.isFinite(load.currentLoad)) {
        items.push({ title: 'CPU', status: pct(load.currentLoad), needsAttention: load.currentLoad >= warn.cpu, updatedAt: now })
      }

      if (mem && mem.total > 0) {
        // `available` counts reclaimable cache as free, which is what "am I out of memory" means.
        const used = mem.total - (Number.isFinite(mem.available) ? mem.available : mem.free)
        const usedPct = (used / mem.total) * 100
        items.push({
          title: 'Memory',
          status: `${pct(usedPct)} of ${gb(mem.total)}`,
          needsAttention: usedPct >= warn.mem,
          updatedAt: now,
        })
      }

      const seen = new Set()
      for (const d of Array.isArray(disks) ? disks : []) {
        if (!(d.size >= MIN_DISK_BYTES) || !Number.isFinite(d.use) || seen.has(d.fs)) continue
        seen.add(d.fs)
        items.push({
          title: `Disk ${d.mount || d.fs}`,
          status: `${pct(d.use)} of ${gb(d.size)}`,
          needsAttention: d.use >= warn.disk,
          updatedAt: now,
        })
      }

      // Only controllers that report a load are listed; most integrated GPUs do not.
      for (const g of graphics?.controllers || []) {
        if (!Number.isFinite(g.utilizationGpu)) continue
        const vram = g.memoryTotal > 0 && Number.isFinite(g.memoryUsed) ? `, ${pct((g.memoryUsed / g.memoryTotal) * 100)} VRAM` : ''
        items.push({
          title: `GPU ${g.model || ''}`.trim(),
          status: `${pct(g.utilizationGpu)}${vram}`,
          needsAttention: g.utilizationGpu >= warn.gpu,
          updatedAt: now,
        })
      }

      const top = (procs?.list || [])
        .filter((p) => Number.isFinite(p.cpu))
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, 3)
      for (const p of top) {
        items.push({
          title: `Process ${p.name}`,
          status: `${pct(p.cpu)} CPU, ${pct(p.mem || 0)} RAM`,
          needsAttention: false,
          updatedAt: now,
        })
      }

      if (!items.length) throw new Error('the operating system returned no readings')
      return items
    },
  }
}

export default createSystemConnector()
