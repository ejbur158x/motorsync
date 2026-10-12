// [port] Single-threaded stand-ins for <thread>/<mutex>/<condition_variable> (WASM build, no threads).
#ifndef ES_NOTHREADS_H
#define ES_NOTHREADS_H
namespace std {
struct mutex { void lock() {} void unlock() {} };
template <class M> struct lock_guard { explicit lock_guard(M &) {} };
template <class M> struct unique_lock { explicit unique_lock(M &) {} void unlock() {} void lock() {} };
struct condition_variable {
    template <class L, class P> void wait(L &, P) {}
    void notify_one() {} void notify_all() {}
};
struct thread { template <class F, class... A> thread(F &&, A &&...) {} void join() {} };
}
#endif
