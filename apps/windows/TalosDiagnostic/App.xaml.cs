using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace TalosDiagnostic
{
    public partial class App : Application
    {
        protected override async void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            var options = LaunchOptions.Parse(e.Args);

            if (options.DumpPath != null)
            {
                // Collect only and write the report to a file (support / tests).
                ShutdownMode = ShutdownMode.OnExplicitShutdown;
                var exitCode = 0;
                try
                {
                    var report = await Task.Run(() => new Collector().Run(null, CancellationToken.None));
                    File.WriteAllText(options.DumpPath, Json.Serialize(report), new UTF8Encoding(false));
                }
                catch (Exception ex)
                {
                    exitCode = 1;
                    try { File.WriteAllText(options.DumpPath + ".error.txt", ex.ToString()); } catch { }
                }
                Shutdown(exitCode);
                return;
            }

            new MainWindow(options).Show();
        }
    }
}
