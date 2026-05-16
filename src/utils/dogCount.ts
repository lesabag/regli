export type DogCount = 1 | 2

export function normalizeDogCount(value: unknown): DogCount {
  return value === 2 ? 2 : 1
}

export function isDogServiceType(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  return (
    normalized === 'dog_walker' ||
    normalized === 'dog_walking' ||
    normalized === 'dog-walker' ||
    normalized === 'dog_sitter' ||
    normalized === 'dog_sitting' ||
    normalized === 'dog-sitter'
  )
}

export function formatDogCountLabel(
  value: unknown,
  options?: { isHebrew?: boolean },
): string {
  const dogCount = normalizeDogCount(value)
  if (options?.isHebrew) {
    return dogCount === 1 ? 'כלב 1' : '2 כלבים'
  }
  return dogCount === 1 ? '1 dog' : '2 dogs'
}
