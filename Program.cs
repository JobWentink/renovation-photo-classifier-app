using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.DependencyInjection;
using SimplePhotoApi;

var host = new HostBuilder()
    .ConfigureFunctionsWorkerDefaults()
    .ConfigureServices(services =>
    {
        services.AddSingleton<PhotoService>();
    })
    .Build();

host.Run();
