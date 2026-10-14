using System;
using System.Linq;
using System.Text.RegularExpressions;

namespace TalosDiagnostic
{
    // Command line:
    //   (none)                  normal launch from the Start menu: intro screen
    //   "talos-diag:..."        launched by the website (MSIX protocol): starts
    //                           scanning right away; the URI carries no options
    //   --dump <file.json>      collect only, write the report to a file, exit
    //   --no-browser            do not open the results page (tests)
    //   --origin <url>          send to a Netlify preview of this site (tests);
    //                           only www.talos-int.com and its previews accepted
    internal sealed class LaunchOptions
    {
        static readonly Regex AllowedOrigin = new Regex(
            @"^https://(www\.talos-int\.com|([a-z0-9-]+--)?sos-pc-website-test-2\.netlify\.app)$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        public bool FromProtocol { get; private set; }
        public bool NoBrowser { get; private set; }
        public string DumpPath { get; private set; }
        public string Origin { get; private set; } = ReportClient.DefaultOrigin;

        public static LaunchOptions Parse(string[] args)
        {
            var options = new LaunchOptions();
            if (args.Any(a => a.StartsWith("talos-diag:", StringComparison.OrdinalIgnoreCase)))
            {
                options.FromProtocol = true;
                return options;
            }

            for (var i = 0; i < args.Length; i++)
            {
                switch (args[i].ToLowerInvariant())
                {
                    case "--dump":
                        if (i + 1 < args.Length) options.DumpPath = args[++i];
                        break;
                    case "--no-browser":
                        options.NoBrowser = true;
                        break;
                    case "--origin":
                        if (i + 1 < args.Length)
                        {
                            var origin = args[++i].TrimEnd('/');
                            if (AllowedOrigin.IsMatch(origin)) options.Origin = origin;
                        }
                        break;
                }
            }
            return options;
        }
    }
}
