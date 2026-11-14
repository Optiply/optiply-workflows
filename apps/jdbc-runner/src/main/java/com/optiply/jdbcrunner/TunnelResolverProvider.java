package com.optiply.jdbcrunner;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.net.spi.InetAddressResolver;
import java.net.spi.InetAddressResolverProvider;
import java.util.stream.Stream;

/**
 * The JVM's name lookups (JEP 418): a tunnelled pool's host names resolve to its tunnel's loopback address, for that
 * pool's work only ({@link Tunnels#using}); everything else as usual. Registered in META-INF/services; every driver's lookups come here.
 */
public final class TunnelResolverProvider extends InetAddressResolverProvider {
  @Override
  public InetAddressResolver get(Configuration configuration) {
    var builtin = configuration.builtinResolver();
    return new InetAddressResolver() {
      @Override
      public Stream<InetAddress> lookupByName(String host, LookupPolicy policy) throws UnknownHostException {
        // Only for the tunnelled pool working on this thread; everyone else gets the system's answer.
        var ip = Tunnels.lookup(host);
        if (ip != null) return Stream.of(ip);
        return builtin.lookupByName(host, policy);
      }

      @Override
      public String lookupByAddress(byte[] addr) throws UnknownHostException {
        return builtin.lookupByAddress(addr);
      }
    };
  }

  @Override
  public String name() {
    return "jdbc-runner-tunnels";
  }
}
