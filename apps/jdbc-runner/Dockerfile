# The JDBC runner (M38): runs JDBC resources' queries, with Oracle, Snowflake and ClickHouse drivers built in and
# admins' uploaded jars. Built with Maven here (its tests run in the build); nobody needs Java installed.
FROM maven:3.9-eclipse-temurin-21-noble AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
# Tests run here by default (CI's docker build). The production build (deploy/cloudbuild.yaml) skips them: CI ran them,
# and TunnelTest's port-closed check races the listener's close on Cloud Build's small machine.
ARG SKIP_TESTS=false
RUN mvn -B -q package -DskipTests=${SKIP_TESTS}

FROM eclipse-temurin:21-jre-noble
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin runner \
  && mkdir -p /drivers /app && chown runner /drivers
COPY --from=build /src/target/lib /app/lib
COPY --from=build /src/target/jdbc-runner.jar /app/jdbc-runner.jar
USER runner
# The drivers keep caches and temporary files under the home and tmp dirs: both in /tmp (a tmpfs in Compose).
# Snowflake's Arrow results need java.nio opened up.
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -Duser.timezone=UTC -Duser.home=/tmp -Djava.io.tmpdir=/tmp --add-opens=java.base/java.nio=ALL-UNNAMED"
EXPOSE 8080
ENTRYPOINT ["java", "-cp", "/app/jdbc-runner.jar:/app/lib/*", "com.optiply.jdbcrunner.Main"]
