function normalizeDogName(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

function normalizeClientDogSize(value: unknown): 'S' | 'M' | 'L' | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  if (normalized === 'S' || normalized === 'M' || normalized === 'L') return normalized
  if (normalized === 'XL') return 'L'
  return null
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index)
}

export function parseRequestedDogNames(dogNameValue: string | null | undefined): string[] {
  const normalized = normalizeDogName(dogNameValue)
  if (!normalized) return []
  return unique(
    normalized
      .split(',')
      .map((value) => normalizeDogName(value))
      .filter(Boolean),
  )
}

export function mergeSelectedDogSizesIntoClientAttributes(
  baseAttributes: Record<string, unknown> | null,
  selectedDogSizes: string[],
): Record<string, unknown> | null {
  const normalizedSelectedDogSizes = unique(
    selectedDogSizes
      .map((size) => normalizeClientDogSize(size))
      .filter((size): size is 'S' | 'M' | 'L' => size !== null),
  )

  if (!baseAttributes && normalizedSelectedDogSizes.length === 0) return null

  const baseDogWalker =
    baseAttributes && typeof baseAttributes.dog_walker === 'object' && baseAttributes.dog_walker
      ? { ...(baseAttributes.dog_walker as Record<string, unknown>) }
      : {}

  if (normalizedSelectedDogSizes.length === 0) {
    return {
      ...(baseAttributes ?? {}),
      dog_walker: baseDogWalker,
    }
  }

  return {
    ...(baseAttributes ?? {}),
    dog_walker: {
      ...baseDogWalker,
      selectedDogSizes: normalizedSelectedDogSizes,
    },
  }
}

export async function loadSelectedDogSizesForRequest(params: {
  supabase: {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (column: string, value: unknown) => unknown
      }
    }
  }
  clientId: string | null | undefined
  dogNameValue: string | null | undefined
}): Promise<string[]> {
  if (!params.clientId) return []
  const requestedDogNames = parseRequestedDogNames(params.dogNameValue)
  if (requestedDogNames.length === 0) return []

  const query = params.supabase
    .from('client_pets')
    .select('name, dog_size')
    .eq('client_id', params.clientId)
    .eq('pet_type', 'dog')
    .eq('is_active', true) as {
      data?: Array<{ name?: string | null; dog_size?: string | null }> | null
      error?: { message?: string | null } | null
    }

  const { data, error } = await query

  if (error) {
    console.warn('[request-dog-sizes] failed to load client pets', {
      clientId: params.clientId,
      error: error.message ?? null,
    })
    return []
  }

  const requestedNameSet = new Set(
    requestedDogNames.map((name) => normalizeDogName(name).toLocaleLowerCase()),
  )

  return unique(
    ((data ?? []) as Array<{ name?: string | null; dog_size?: string | null }>)
      .filter((pet) => requestedNameSet.has(normalizeDogName(pet.name).toLocaleLowerCase()))
      .map((pet) => normalizeClientDogSize(pet.dog_size))
      .filter((size): size is 'S' | 'M' | 'L' => size !== null),
  )
}
