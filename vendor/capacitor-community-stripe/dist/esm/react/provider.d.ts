import type { FC, PropsWithChildren, ReactNode } from "react";
import type { StripeInitializationOptions, CapacitorStripeContext } from '../index';
export declare const useCapacitorStripe: () => CapacitorStripeContext;
export type CapacitorStripeProviderProps = PropsWithChildren<StripeInitializationOptions & {
    fallback?: ReactNode;
}>;
export declare const CapacitorStripeProvider: FC<CapacitorStripeProviderProps>;
