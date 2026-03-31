export type BookingStatus =
  | 'IDLE'
  | 'MATCHING'
  | 'TRACKING'
  | 'NO_MATCH'
  | 'COMPLETED'
  | 'CANCELLED';

export type ServiceType = 'quick' | 'standard' | 'energy';

export type Walker = {
  id: string;
  name: string;
  rating: number;
  etaMinutes: number;
};
