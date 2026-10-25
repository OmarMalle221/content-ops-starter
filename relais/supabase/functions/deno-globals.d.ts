// Le strict nécessaire de l'API Deno, pour que `tsc` vérifie aussi les fonctions Edge.
declare const Deno: {
    serve(handler: (request: Request) => Response | Promise<Response>): unknown;
    env: { get(name: string): string | undefined };
};
