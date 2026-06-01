import { WebPlugin } from '@capacitor/core';
import type { ApplePayResultInterface, CreateApplePayOption, CreateGooglePayOption, CreatePaymentFlowOption, CreatePaymentSheetOption, GooglePayResultInterface, PaymentFlowResultInterface, PaymentSheetResultInterface, StripeInitializationOptions, StripePlugin } from './definitions';
export declare class StripeWeb extends WebPlugin implements StripePlugin {
    private publishableKey;
    private stripeAccount;
    private cardElementModal;
    private flowStripe;
    private flowCardNumberElement;
    private requestApplePay;
    private requestApplePayOptions;
    private requestGooglePay;
    private requestGooglePayOptions;
    initialize(options: StripeInitializationOptions): Promise<void>;
    createPaymentSheet(options: CreatePaymentSheetOption): Promise<void>;
    presentPaymentSheet(): Promise<{
        paymentResult: PaymentSheetResultInterface;
    }>;
    createPaymentFlow(options: CreatePaymentFlowOption): Promise<void>;
    presentPaymentFlow(): Promise<{
        cardNumber: string;
    }>;
    confirmPaymentFlow(): Promise<{
        paymentResult: PaymentFlowResultInterface;
    }>;
    isApplePayAvailable(): Promise<void>;
    createApplePay(createApplePayOption: CreateApplePayOption): Promise<void>;
    presentApplePay(): Promise<{
        paymentResult: ApplePayResultInterface;
    }>;
    isGooglePayAvailable(): Promise<void>;
    createGooglePay(createGooglePayOption: CreateGooglePayOption): Promise<void>;
    presentGooglePay(): Promise<{
        paymentResult: GooglePayResultInterface;
    }>;
    private isAvailable;
    private createPaymentRequestButton;
    private presentPaymentRequestButton;
}
