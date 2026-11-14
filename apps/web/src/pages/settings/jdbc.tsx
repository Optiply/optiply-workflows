import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, Plus } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { Button, Card, EmptyState, ErrorNote, Field, Input, Spinner, Table, Td, Th } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { AdminOnly } from './layout'

/**
 * JDBC drivers (M38, docs/runbooks/jdbc.md): jars admins upload for JDBC resources whose database has no built-in
 * driver (Oracle, Snowflake and ClickHouse are built in). A driver is code the JDBC runner runs: upload only jars from
 * the database's vendor, and check the SHA-256 against theirs.
 */
export function JdbcSettingsPage() {
  return (
    <AdminOnly>
      <JdbcDrivers />
    </AdminOnly>
  )
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

function JdbcDrivers() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: drivers, isLoading, error } = useQuery(trpc.jdbcDrivers.list.queryOptions())
  const [adding, setAdding] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.jdbcDrivers.list.queryKey() })
  const remove = useMutation(trpc.jdbcDrivers.delete.mutationOptions({ onSuccess: refresh }))

  if (isLoading) return <Spinner />
  if (!drivers) return <ErrorNote error={error} />

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          Drivers for JDBC resources whose database isn't built in (Oracle, Snowflake and ClickHouse are). A
          driver is code the JDBC runner runs next to other resources' connections: upload only the database
          vendor's own jar, and check its SHA-256 against theirs.
        </p>
        <Button variant="primary" onClick={() => setAdding(!adding)} data-testid="jdbc-driver-new">
          <Plus className="size-4" /> Upload a driver
        </Button>
      </div>
      {adding && (
        <UploadForm
          onDone={() => {
            setAdding(false)
            refresh()
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      <ErrorNote error={remove.error} />

      {drivers.length === 0 ? (
        <EmptyState icon={<Database className="size-6" />} title="No uploaded drivers">
          Upload one for a database without a built-in driver: DB2, Exasol, SAP HANA, Teradata, Databricks…
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Driver</Th>
              <Th>Class</Th>
              <Th>SHA-256</Th>
              <Th>Uploaded</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d.id} data-testid={`jdbc-driver-${d.name}`}>
                <Td>
                  <div className="font-medium">{d.name}</div>
                  <div className="font-mono text-xs text-muted">
                    {d.fileName} · {size(d.size)}
                  </div>
                </Td>
                <Td className="font-mono text-xs">{d.className}</Td>
                <Td className="max-w-56 font-mono text-xs break-all text-muted">{d.sha256}</Td>
                <Td className="text-xs text-muted">
                  <div>{new Date(d.createdAt).toLocaleString()}</div>
                  {d.uploadedBy && <div>{d.uploadedBy}</div>}
                </Td>
                <Td className="w-24 text-right">
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (
                        await confirmDialog(
                          `Delete the driver "${d.name}"? Resources using it can't run until they use another.`,
                          {
                            danger: true,
                            confirm: 'Delete',
                          },
                        )
                      ) {
                        remove.mutate({ id: d.id })
                      }
                    }}
                  >
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}

function UploadForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [className, setClassName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function upload() {
    if (!file) return
    setBusy(true)
    setProblem(null)
    try {
      const query = new URLSearchParams({ name, className, fileName: file.name })
      const res = await fetch(`/api/v1/jdbc-drivers?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/java-archive' },
        body: file,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
        setProblem(body.error?.message ?? `The upload failed (${res.status})`)
        return
      }
      onDone()
    } catch (err) {
      setProblem((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" hint="How resources list it, e.g. IBM DB2 12.">
          <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="jdbc-driver-name" />
        </Field>
        <Field label="Driver class" hint="The jar's java.sql.Driver, from the vendor's documentation.">
          <Input
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            placeholder="com.ibm.db2.jcc.DB2Driver"
            className="font-mono"
            data-testid="jdbc-driver-class"
          />
        </Field>
      </div>
      <Field label="Jar" hint="At most 100 MB.">
        <input
          type="file"
          accept=".jar,application/java-archive"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm"
          data-testid="jdbc-driver-file"
        />
      </Field>
      {problem && (
        <p className="text-sm text-danger" data-testid="jdbc-driver-problem">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!file || !name.trim() || !className.trim() || busy}
          onClick={upload}
        >
          {busy ? 'Uploading…' : 'Upload'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  )
}
