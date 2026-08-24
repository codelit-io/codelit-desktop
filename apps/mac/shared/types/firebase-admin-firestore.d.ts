declare module "firebase-admin/firestore" {
  interface Transaction {
    get(reference: any): Promise<any>;
    set(reference: any, value: any, options?: any): Transaction;
    create(reference: any, value: any): Transaction;
    update(reference: any, value: any): Transaction;
  }

  export interface Firestore {
    collection(path: string): any;
    runTransaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>;
  }
}
